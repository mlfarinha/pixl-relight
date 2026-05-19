/* ========================================================================
   PIXLRelight interactive demo.

   Reads <site_root>/site_config.json for the assets URL prefix, then
   <site_root>/scenes_config.json for the list of scenes. For each scene
   fetches <assets_root>/<scene_id>/meta.json to learn the grid dimensions
   and preset names. Renders the controls (scene thumbnails + light
   buttons) and tracks pointer position over the image, snapping to the
   nearest grid cell.

   Preloading: when a (scene, preset) becomes active we eagerly prefetch
   every cell in the background, ordered by distance from the user's
   cursor so nearby cells land first. Concurrency is capped; stale
   prefetches are cancelled when the user switches scene/preset.

   Performance notes:
   - Visible images use fetchPriority="high"; prefetch uses fetch() with
     low priority so the browser always serves the visible cell first.
   - Prefetch uses fetch() rather than new Image() to populate only the
     HTTP cache. new Image() also decodes every prefetched JPEG into a
     RGBA bitmap in Firefox's image cache, which causes massive memory
     pressure and triggers eviction of the currently-displayed buffers
     (manifesting as black flashes on hover).
   - After decode() resolves we wait one rAF before flipping opacity:
     in Firefox the bitmap is occasionally not yet handed to the
     compositor when decode() returns, and flipping in the same
     microtask shows a black frame.
   - The cursor ring is updated synchronously on mousemove
     (transform-only, no layout) so it tracks the pointer even when an
     image is decoding.
   - Add `<link rel="preconnect" href="https://huggingface.co" crossorigin>`
     to index.html so the TLS handshake doesn't block the first request.
   ======================================================================== */

(function () {
  "use strict";

  // ============================================================
  // Configuration / paths
  // ============================================================

  let OUTPUTS_ROOT = "./web_assets";
  let EAGER_PRELOAD_FULL = true;

  // Retry policy for JSON fetches. HF's CDN occasionally returns 429
  // under burst load; we honor Retry-After if present and back off
  // exponentially otherwise.
  async function fetchJSON(url, { maxRetries = 4 } = {}) {
    let delay = 500;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let res;
      try {
        res = await fetch(url);
      } catch (err) {
        if (attempt === maxRetries) throw err;
        await sleep(delay);
        delay *= 2;
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 429 && attempt < maxRetries) {
        const retryAfter = parseFloat(res.headers.get("Retry-After"));
        const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : delay;
        await sleep(wait);
        delay *= 2;
        continue;
      }
      throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
    }
    throw new Error(`fetch ${url} failed after ${maxRetries} retries`);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function clampInt(n, lo, hi) {
    n = Math.round(n);
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function cellURL(sceneId, preset, u, v) {
    const uu = String(u).padStart(2, "0");
    const vv = String(v).padStart(2, "0");
    return `${OUTPUTS_ROOT}/${sceneId}/${preset}/relit/${uu}_${vv}.jpg`;
  }

  function sourceURL(sceneId) {
    return `${OUTPUTS_ROOT}/${sceneId}/source.jpg`;
  }

  // Background prefetch via fetch() instead of new Image().
  //
  // Why fetch() and not Image(): new Image() forces the browser to
  // decode each JPEG into a raw RGBA bitmap and hold it in its image
  // cache. With hundreds of large prefetched JPEGs, Firefox's image
  // cache balloons to hundreds of megabytes and starts evicting
  // bitmaps -- including those of the two <img> elements we use for
  // display, which then flash black on next paint. fetch() only
  // populates the HTTP byte cache; the JPEG is decoded on demand by
  // the <img> when it's actually displayed.
  //
  // mode "no-cors" lets us cache opaque responses without requiring
  // CORS headers from the asset host. priority "low" is a hint that
  // recent browsers honor; older browsers ignore it harmlessly.
  function preload(url) {
    return fetch(url, {
      mode: "no-cors",
      credentials: "omit",
      priority: "low",
    }).then(() => url, () => null);
  }

  // ============================================================
  // State
  // ============================================================
  let scenesConfig = null;
  let scenes = [];
  let currentSceneIdx = 0;
  let currentPreset = null;
  const preloadCompleted = new Set();
  let currentSrc = null;

  // Last pointer position (in stage-local cell coords).
  let lastCursorU = null;
  let lastCursorV = null;

  // Last cell dispatched to setImageToCell. Lets us skip work when
  // the cursor moves within the same cell.
  let lastDispatchedU = null;
  let lastDispatchedV = null;

  const mount = document.getElementById("demo-mount");
  if (!mount) {
    console.error("demo: no #demo-mount element");
    return;
  }

  async function bootstrap() {
    try {
      const site = await fetchJSON("site_config.json");
      if (typeof site.assets_root === "string" && site.assets_root.length > 0) {
        OUTPUTS_ROOT = site.assets_root.replace(/\/+$/, "");
      }
      if (typeof site.eager_preload_full === "boolean") {
        EAGER_PRELOAD_FULL = site.eager_preload_full;
      }
    } catch (err) {
      console.warn("site_config.json not loaded; using default:", err.message);
    }

    try {
      const configURL = mount.dataset.config || "scenes_config.json";
      scenesConfig = await fetchJSON(configURL);
      if (!Array.isArray(scenesConfig.scenes) || scenesConfig.scenes.length === 0) {
        throw new Error("scenes_config.json: `scenes` array is empty");
      }
    } catch (err) {
      showError(err.message);
      return;
    }

    // Per-scene meta.json. Use allSettled so a single 429 doesn't kill
    // the entire demo -- the user still gets the scenes that loaded.
    const results = await Promise.allSettled(
      scenesConfig.scenes.map(async (entry) => {
        const meta = await fetchJSON(`${OUTPUTS_ROOT}/${entry.scene_id}/meta.json`);
        return {
          id: entry.scene_id,
          label: entry.label || entry.scene_id,
          margin: meta.grid.margin || 0.05,
          gridW: meta.grid.width,
          gridH: meta.grid.height,
          sourceW: meta.source_image ? meta.source_image.width : 940,
          sourceH: meta.source_image ? meta.source_image.height : 560,
          availablePresets: meta.presets.map((p) => p.name),
          presetUI: entry.presets || meta.presets.map((p) => ({
            name: p.name,
            label: p.name,
          })),
        };
      })
    );
    scenes = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length) {
      console.warn(
        `${failures.length} scene(s) failed to load:`,
        failures.map((f) => f.reason && f.reason.message)
      );
    }
    if (scenes.length === 0) {
      showError(
        "No scenes loaded. The asset host may be rate-limiting; try refreshing in a moment."
      );
      return;
    }

    for (const s of scenes) {
      s.presetUI = s.presetUI.filter((p) => s.availablePresets.includes(p.name));
    }

    render();
  }

  function showError(msg) {
    mount.innerHTML = "";
    const el = document.createElement("div");
    el.className = "demo-loading";
    el.textContent = `Failed to load demo: ${msg}`;
    mount.appendChild(el);
  }

  // ============================================================
  // Rendering
  // ============================================================
  function render() {
    mount.innerHTML = "";

    const stage = document.createElement("div");
    stage.className = "demo-stage";
    stage.id = "demo-stage";
    const firstScene = scenes[0];
    stage.style.aspectRatio = `${firstScene.sourceW} / ${firstScene.sourceH}`;

    const imgA = document.createElement("img");
    imgA.className = "demo-img demo-img-a";
    imgA.alt = "Relit photograph";
    imgA.draggable = false;
    imgA.decoding = "async";
    imgA.fetchPriority = "high";
    stage.appendChild(imgA);

    const imgB = document.createElement("img");
    imgB.className = "demo-img demo-img-b";
    imgB.alt = "";
    imgB.draggable = false;
    imgB.decoding = "async";
    imgB.fetchPriority = "high";
    imgB.style.opacity = "0";
    stage.appendChild(imgB);

    const ring = document.createElement("div");
    ring.className = "cursor-ring";
    ring.style.left = "0";
    ring.style.top = "0";
    ring.style.willChange = "transform, opacity";
    ring.style.opacity = "0";
    stage.appendChild(ring);

    const progress = document.createElement("div");
    progress.className = "demo-progress";
    progress.style.opacity = "0";
    stage.appendChild(progress);

    const controls = document.createElement("div");
    controls.className = "demo-controls";

    if (scenes.length > 1) {
      const sceneGroup = document.createElement("div");
      sceneGroup.className = "demo-group";
      const lbl = document.createElement("span");
      lbl.className = "demo-group-label";
      lbl.textContent = "Scene";
      sceneGroup.appendChild(lbl);
      scenes.forEach((s, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "demo-btn scene-btn";
        btn.dataset.idx = i;
        btn.setAttribute("aria-label", s.label);
        btn.title = s.label;
        const thumb = document.createElement("img");
        thumb.src = sourceURL(s.id);
        thumb.alt = "";
        btn.appendChild(thumb);
        btn.addEventListener("click", () => selectScene(i));
        sceneGroup.appendChild(btn);
      });
      controls.appendChild(sceneGroup);
    }

    const presetGroup = document.createElement("div");
    presetGroup.className = "demo-group";
    const presetLbl = document.createElement("span");
    presetLbl.className = "demo-group-label";
    presetLbl.textContent = "Light";
    presetGroup.appendChild(presetLbl);
    const presetButtonsHolder = document.createElement("span");
    presetButtonsHolder.id = "preset-buttons";
    presetGroup.appendChild(presetButtonsHolder);
    controls.appendChild(presetGroup);

    mount.appendChild(stage);
    mount.appendChild(controls);

    setupInput(stage, ring);

    selectScene(0);
  }

  function selectScene(idx) {
    if (idx < 0 || idx >= scenes.length) return;
    currentSceneIdx = idx;
    const scene = scenes[idx];

    document.querySelectorAll(".demo-btn.scene-btn").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.idx) === idx);
    });

    const holder = document.getElementById("preset-buttons");
    holder.innerHTML = "";
    scene.presetUI.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "demo-btn preset-btn";
      btn.textContent = p.label;
      btn.dataset.preset = p.name;
      btn.addEventListener("click", () => selectPreset(p.name));
      holder.appendChild(btn);
    });

    let preset = currentPreset;
    if (!scene.presetUI.some((p) => p.name === preset)) {
      preset = scene.presetUI[0] ? scene.presetUI[0].name : null;
    }
    currentSrc = null;
    lastDispatchedU = null;
    lastDispatchedV = null;
    if (preset) selectPreset(preset);
  }

  function selectPreset(name) {
    currentPreset = name;
    document.querySelectorAll(".demo-btn.preset-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.preset === name);
    });
    const scene = scenes[currentSceneIdx];
    const u = lastCursorU != null ? lastCursorU : Math.floor(scene.gridW / 2);
    const v = lastCursorV != null ? lastCursorV : Math.floor(scene.gridH / 2);
    currentSrc = null;
    lastDispatchedU = null;
    lastDispatchedV = null;
    setImageToCell(u, v);
    // Defer the prefetch flood by one task so the high-priority visible
    // cell gets a connection slot first.
    setTimeout(() => prefetchAllCells(scene, name, u, v), 0);
  }

  // ============================================================
  // Double-buffered cell display
  //
  // The two <img> elements imgA and imgB are stacked. At any moment,
  // exactly one is the "front" (opacity 1) and the other is the "back"
  // (opacity 0). To show a new cell:
  //   1. Set back.src = url
  //   2. await back.decode() (with a timeout fallback)
  //   3. Wait one rAF so the decoded bitmap is compositor-ready
  //      (Firefox sometimes resolves decode() slightly early)
  //   4. Flip the front/back roles via opacity
  // ============================================================
  let frontIsA = true;
  let latestRequested = null;
  const DECODE_TIMEOUT_MS = 2000;

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function decodeWithTimeout(img) {
    return Promise.race([
      img.decode().then(() => "ok", () => "error"),
      sleep(DECODE_TIMEOUT_MS).then(() => "timeout"),
    ]);
  }

  async function setImageToCell(u, v) {
    const scene = scenes[currentSceneIdx];
    const url = cellURL(scene.id, currentPreset, u, v);
    if (url === currentSrc) return;
    currentSrc = url;
    latestRequested = url;

    const imgA = mount.querySelector(".demo-img-a");
    const imgB = mount.querySelector(".demo-img-b");
    if (!imgA || !imgB) return;

    const back = frontIsA ? imgB : imgA;
    const front = frontIsA ? imgA : imgB;

    back.src = url;
    const status = await decodeWithTimeout(back);

    // Stale-result guard: a faster cursor move may already have queued
    // a different URL. If so, leave the front alone.
    if (latestRequested !== url) return;
    // Hard failure: decode rejected (404 / bad bytes). Don't flip;
    // the user keeps seeing the previous cell.
    if (status === "error") return;

    // Firefox safety: give the compositor one frame to bind the
    // decoded bitmap before we make it visible. Without this, the
    // very first frame after the opacity flip can be black.
    await nextFrame();
    if (latestRequested !== url) return;

    // Defensive: the image element should have valid dimensions now.
    // If not (decode timed out and bytes weren't really ready), skip.
    if (!back.complete || back.naturalWidth === 0) return;

    back.style.opacity = "1";
    front.style.opacity = "0";
    frontIsA = !frontIsA;
  }

  function setupInput(stage, ring) {
    function pointerToCell(clientX, clientY) {
      const rect = stage.getBoundingClientRect();
      let x = (clientX - rect.left) / rect.width;
      let y = (clientY - rect.top) / rect.height;
      const scene = scenes[currentSceneIdx];
      const m = scene.margin || 0.05;
      x = Math.max(m, Math.min(1 - m, x));
      y = Math.max(m, Math.min(1 - m, y));
      const ux = (x - m) / (1 - 2 * m);
      const vy = (y - m) / (1 - 2 * m);
      return {
        u: clampInt(ux * (scene.gridW - 1), 0, scene.gridW - 1),
        v: clampInt(vy * (scene.gridH - 1), 0, scene.gridH - 1),
        screenX: clientX - rect.left,
        screenY: clientY - rect.top,
      };
    }

    function updateRing(screenX, screenY) {
      ring.style.transform = `translate3d(${screenX}px, ${screenY}px, 0)`;
      ring.style.opacity = "1";
    }

    let pending = null;
    function handlePointer(clientX, clientY) {
      pending = { x: clientX, y: clientY };
      if (handlePointer.scheduled) return;
      handlePointer.scheduled = true;
      requestAnimationFrame(() => {
        handlePointer.scheduled = false;
        if (!pending) return;
        const { u, v } = pointerToCell(pending.x, pending.y);
        pending = null;
        lastCursorU = u;
        lastCursorV = v;
        // Skip the dispatch if the cursor hasn't crossed a cell
        // boundary. Every sub-pixel mouse jiggle would otherwise
        // schedule redundant work that piles up under Firefox's
        // slower image pipeline.
        if (u === lastDispatchedU && v === lastDispatchedV) return;
        lastDispatchedU = u;
        lastDispatchedV = v;
        setImageToCell(u, v);
      });
    }

    stage.addEventListener("mousemove", (e) => {
      const rect = stage.getBoundingClientRect();
      updateRing(e.clientX - rect.left, e.clientY - rect.top);
      handlePointer(e.clientX, e.clientY);
    });
    stage.addEventListener("mouseleave", () => {
      pending = null;
      ring.style.opacity = "0";
    });
    stage.addEventListener("mouseenter", () => {
      ring.style.opacity = "1";
    });

    stage.addEventListener("touchstart", (e) => {
      stage.classList.add("touch-active");
      const t = e.touches[0];
      if (!t) return;
      const rect = stage.getBoundingClientRect();
      updateRing(t.clientX - rect.left, t.clientY - rect.top);
      handlePointer(t.clientX, t.clientY);
    }, { passive: true });
    stage.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (!t) return;
      const rect = stage.getBoundingClientRect();
      updateRing(t.clientX - rect.left, t.clientY - rect.top);
      handlePointer(t.clientX, t.clientY);
    }, { passive: true });
    stage.addEventListener("touchend", () => {
      stage.classList.remove("touch-active");
      ring.style.opacity = "0";
    });
  }

  // ============================================================
  // Preloading
  //
  // When a (scene, preset) becomes active we kick off background
  // requests for every cell, ordered by distance from the user's
  // cursor (or grid center if no cursor yet). The browser caches them
  // in its HTTP cache, so once they're done the demo is fully instant.
  //
  // Concurrency: 4 keeps the network busy without saturating Firefox's
  // image decoder. Browsers cap at ~6 concurrent connections per
  // origin, but Firefox's decoder is more sensitive than Chrome's to
  // many simultaneous loads when display is also happening.
  // ============================================================
  const PRELOAD_CONCURRENCY = 4;
  let currentPrefetchToken = 0;

  async function prefetchAllCells(scene, preset, cursorU, cursorV) {
    if (!EAGER_PRELOAD_FULL) return;

    currentPrefetchToken++;
    const myToken = currentPrefetchToken;

    const key = `${scene.id}::${preset}`;
    if (preloadCompleted.has(key)) return;

    const cu = cursorU != null ? cursorU : Math.floor(scene.gridW / 2);
    const cv = cursorV != null ? cursorV : Math.floor(scene.gridH / 2);
    const cells = [];
    for (let u = 0; u < scene.gridW; u++) {
      for (let v = 0; v < scene.gridH; v++) {
        cells.push({ u, v });
      }
    }
    cells.sort((a, b) => {
      const da = (a.u - cu) * (a.u - cu) + (a.v - cv) * (a.v - cv);
      const db = (b.u - cu) * (b.u - cu) + (b.v - cv) * (b.v - cv);
      return da - db;
    });

    const total = cells.length;
    let completed = 0;
    const progressEl = mount.querySelector(".demo-progress");
    if (progressEl) {
      progressEl.textContent = "Loading lighting… 0%";
      progressEl.style.opacity = "1";
    }

    let nextIdx = 0;
    async function worker() {
      while (true) {
        if (myToken !== currentPrefetchToken) return;
        const i = nextIdx++;
        if (i >= cells.length) return;
        const { u, v } = cells[i];
        await preload(cellURL(scene.id, preset, u, v));
        if (myToken !== currentPrefetchToken) return;
        completed++;
        if (progressEl && completed % 4 === 0) {
          const pct = Math.floor((completed / total) * 100);
          progressEl.textContent = `Loading lighting… ${pct}%`;
        }
      }
    }
    const workers = [];
    for (let w = 0; w < PRELOAD_CONCURRENCY; w++) workers.push(worker());
    await Promise.all(workers);

    if (myToken === currentPrefetchToken) {
      preloadCompleted.add(key);
      if (progressEl) {
        progressEl.textContent = "Ready";
        setTimeout(() => {
          if (progressEl) progressEl.style.opacity = "0";
        }, 600);
      }
    }
  }

  bootstrap();
})();