/* ========================================================================
   PIXLRelight interactive demo.

   Reads <site_root>/site_config.json for the assets URL prefix, then
   <site_root>/scenes_config.json for the list of scenes. For each scene
   fetches <assets_root>/<scene_id>/meta.json to learn the grid dimensions
   and preset names. Renders the controls (scene thumbnails + light
   buttons) and tracks pointer position over the image, snapping to the
   nearest grid cell.

   Preloading: when a (scene, preset) becomes active we eagerly prefetch
   a sparse "skeleton" (every 4th cell) so the first hover always has a
   nearby loaded image. The browser cache fills as the user moves.
   ======================================================================== */

(function () {
  "use strict";

  // ============================================================
  // Configuration / paths
  //
  // Paths in this file are resolved relative to index.html, NOT this
  // file. So `site_config.json` is just "site_config.json", and
  // OUTPUTS_ROOT inherits the prefix declared in that config.
  // ============================================================

  let OUTPUTS_ROOT = "./web_assets";
  // If true, immediately fetch every cell for the currently-active
  // (scene, preset) so motion is instant. ~80 MB per (scene, preset)
  // combination — overrides the older "skeleton" prefetch. Configurable
  // from site_config.json (key: `eager_preload_full`).
  let EAGER_PRELOAD_FULL = true;

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
    return res.json();
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

  function preload(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(url);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // ============================================================
  // State
  // ============================================================
  let scenesConfig = null;
  let scenes = [];
  let currentSceneIdx = 0;
  let currentPreset = null;
  const preloadStarted = new Set();
  let currentSrc = null;

  const mount = document.getElementById("demo-mount");
  if (!mount) {
    console.error("demo: no #demo-mount element");
    return;
  }

  async function bootstrap() {
    // 1. site_config.json — gives OUTPUTS_ROOT.
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

    // 2. scenes_config.json — what to show.
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

    // 3. Per-scene meta.json (parallel fetch).
    try {
      scenes = await Promise.all(
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
        }),
      );
    } catch (err) {
      showError(err.message);
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

    // Double-buffered image swap: two <img> elements stacked. The "front"
    // is what the user sees; we load the next cell into the "back" and
    // wait for img.decode() before flipping. This avoids the half-paint
    // flash that direct `img.src = url` causes on cold cells.
    const imgA = document.createElement("img");
    imgA.className = "demo-img demo-img-a";
    imgA.alt = "Relit photograph";
    imgA.draggable = false;
    imgA.decoding = "async";
    stage.appendChild(imgA);

    const imgB = document.createElement("img");
    imgB.className = "demo-img demo-img-b";
    imgB.alt = "";
    imgB.draggable = false;
    imgB.decoding = "async";
    imgB.style.opacity = "0";
    stage.appendChild(imgB);

    const ring = document.createElement("div");
    ring.className = "cursor-ring";
    stage.appendChild(ring);

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
    if (preset) selectPreset(preset);
  }

  function selectPreset(name) {
    currentPreset = name;
    document.querySelectorAll(".demo-btn.preset-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.preset === name);
    });
    const scene = scenes[currentSceneIdx];
    const u = Math.floor(scene.gridW / 2);
    const v = Math.floor(scene.gridH / 2);
    setImageToCell(u, v);
    prefetchAllCells(scene, name);
  }

  // ============================================================
  // Double-buffered cell display
  //
  // The two <img> elements imgA and imgB are stacked in the DOM. At
  // any moment, exactly one is the "front" (opacity 1) and the other
  // is the "back" (opacity 0). To show a new cell:
  //   1. Set back.src = url
  //   2. await back.decode()  (rejects if image fails)
  //   3. Flip the front/back roles via opacity
  // The browser cache means warm cells decode in <5 ms, so the swap is
  // imperceptible. Cold cells fetch + decode in ~150-400 ms; during
  // that wait the front (last loaded) image keeps showing, so there's
  // never a flash to blank.
  //
  // `latestRequested` lets us discard stale decode() callbacks: if the
  // user moves the cursor faster than the network, only the most-recent
  // cell ends up displayed.
  // ============================================================
  let frontIsA = true;
  let latestRequested = null;

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
    try {
      await back.decode();
    } catch {
      // Decode failed (404, network error, or a newer src superseded
      // this one). Either way: don't flip.
      return;
    }
    // Stale-result guard: a faster cursor move may already have queued
    // a different URL. If so, leave the front alone.
    if (latestRequested !== url) return;

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

    let pending = null;
    function handlePointer(clientX, clientY) {
      pending = { x: clientX, y: clientY };
      if (handlePointer.scheduled) return;
      handlePointer.scheduled = true;
      requestAnimationFrame(() => {
        handlePointer.scheduled = false;
        if (!pending) return;
        const { u, v, screenX, screenY } = pointerToCell(pending.x, pending.y);
        pending = null;
        setImageToCell(u, v);
        ring.style.left = screenX + "px";
        ring.style.top = screenY + "px";
      });
    }

    stage.addEventListener("mousemove", (e) => handlePointer(e.clientX, e.clientY));
    stage.addEventListener("mouseleave", () => { pending = null; });

    stage.addEventListener("touchstart", (e) => {
      stage.classList.add("touch-active");
      const t = e.touches[0];
      if (t) handlePointer(t.clientX, t.clientY);
    }, { passive: true });
    stage.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (t) handlePointer(t.clientX, t.clientY);
    }, { passive: true });
    stage.addEventListener("touchend", () => {
      stage.classList.remove("touch-active");
    });
  }

  // ============================================================
  // Preloading
  //
  // When a (scene, preset) becomes active we kick off background
  // requests for every cell. The browser caches them, so once they're
  // done the demo is fully instant — no per-cell network latency on
  // hover.
  //
  // We throttle concurrent in-flight requests with a small semaphore
  // (default 8). Browsers cap at ~6 concurrent connections per origin
  // anyway, so 8 keeps the pipe full without piling up.
  // ============================================================
  const PRELOAD_CONCURRENCY = 8;

  async function prefetchAllCells(scene, preset) {
    if (!EAGER_PRELOAD_FULL) return;

    const key = `${scene.id}::${preset}`;
    if (preloadStarted.has(key)) return;
    preloadStarted.add(key);

    const urls = [];
    for (let u = 0; u < scene.gridW; u++) {
      for (let v = 0; v < scene.gridH; v++) {
        urls.push(cellURL(scene.id, preset, u, v));
      }
    }

    // Drive the queue with a fixed-size pool of workers.
    let nextIdx = 0;
    async function worker() {
      while (true) {
        const i = nextIdx++;
        if (i >= urls.length) return;
        await preload(urls[i]);
      }
    }
    const workers = [];
    for (let w = 0; w < PRELOAD_CONCURRENCY; w++) workers.push(worker());
    await Promise.all(workers);
  }

  bootstrap();
})();