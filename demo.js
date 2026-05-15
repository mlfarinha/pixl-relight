/* ========================================================================
   PIXLRelight interactive demo.

   Workflow:
     1. Read scenes_config.json. Each entry names a scene_id + its preset
        labels for the UI.
     2. For each scene, fetch <outputs_root>/<scene_id>/meta.json for grid
        dimensions and preset names.
     3. Render the controls (scene thumbnails + preset buttons).
     4. On mouse/touch over the image: map cursor (x, y) to grid cell
        (u_idx, v_idx), snap to a path under the current preset, set the
        <img> src.

   Preloading:
     - When a (scene, preset) becomes active, eagerly prefetch a sparse
       "skeleton" (every 4th cell) so the first hover always has a nearby
       loaded image to fall back on.
     - Beyond that, the browser cache fills as the user moves. Tested: on
       a 32x32 grid, after a few seconds of hovering most cells are cached.

   Touch:
     - touchstart/touchmove drives the same hover-position logic. We set
       a `.touch-active` class to keep the cursor ring visible.
   ======================================================================== */

(function () {
  "use strict";

  // ============================================================
  // Configuration / paths
  // ============================================================

  // OUTPUTS_ROOT is loaded from site_config.json at startup. Default value
  // works for `python -m http.server` in the website/ parent directory; for
  // deployment, edit site_config.json to point at your Hugging Face
  // dataset's `resolve/main` URL.
  let OUTPUTS_ROOT = "../web_assets";

  // ============================================================
  // Tiny utilities
  // ============================================================

  /** Fetch JSON with friendly error context. */
  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) {
      throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  /** Clamp an integer into [lo, hi]. */
  function clampInt(n, lo, hi) {
    n = Math.round(n);
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  /** Format `<root>/<scene_id>/<preset>/relit/<UU>_<VV>.jpg`. */
  function cellURL(sceneId, preset, u, v) {
    const uu = String(u).padStart(2, "0");
    const vv = String(v).padStart(2, "0");
    return `${OUTPUTS_ROOT}/${sceneId}/${preset}/relit/${uu}_${vv}.jpg`;
  }

  /** Format `<root>/<scene_id>/source.jpg`. */
  function sourceURL(sceneId) {
    return `${OUTPUTS_ROOT}/${sceneId}/source.jpg`;
  }

  /** Preload an image into the browser cache; resolve when loaded. */
  function preload(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(url);
      img.onerror = () => resolve(null); // Don't reject — missing cells are OK.
      img.src = url;
    });
  }

  // ============================================================
  // State
  // ============================================================

  let scenesConfig = null;       // Loaded from scenes_config.json
  let scenes = [];               // Per-scene state, populated below.
  let currentSceneIdx = 0;
  let currentPreset = null;      // preset name string

  // Set of (sceneId, preset) we've already kicked off skeleton-preloading for.
  const skeletonPreloaded = new Set();

  // Track in-flight image src so we don't reset to the same URL repeatedly.
  let currentSrc = null;

  // ============================================================
  // DOM mount
  // ============================================================

  const mount = document.getElementById("demo-mount");
  if (!mount) {
    console.error("demo: no #demo-mount element");
    return;
  }

  async function bootstrap() {
    // 1. Load the top-level site config (where assets live).
    try {
      const site = await fetchJSON("site_config.json");
      if (typeof site.assets_root === "string" && site.assets_root.length > 0) {
        // Strip trailing slash so we can safely concat with "/<scene>/..."
        OUTPUTS_ROOT = site.assets_root.replace(/\/+$/, "");
      }
    } catch (err) {
      // Non-fatal — fall back to the compiled-in default.
      console.warn("site_config.json not loaded; using default assets_root:", err.message);
    }

    // 2. Load the scenes list.
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

    // For each scene, fetch its meta.json in parallel.
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
            // Map the user-facing preset labels to the actual directory names.
            // scenes_config.json declares which presets to expose and what to
            // call them in the UI; meta.json is the source of truth for which
            // presets exist on disk.
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

    // Filter any UI preset rows whose underlying preset isn't actually rendered
    // for this scene. This keeps the buttons honest if you re-render with a
    // smaller set of presets later.
    for (const s of scenes) {
      s.presetUI = s.presetUI.filter((p) => s.availablePresets.includes(p.name));
      if (s.presetUI.length === 0) {
        console.warn(`Scene ${s.id} has no UI presets after filtering`);
      }
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

    // ---- The stage (image + cursor ring) ----
    const stage = document.createElement("div");
    stage.className = "demo-stage";
    stage.id = "demo-stage";
    // Keep aspect ratio close to the first scene's source so the page
    // doesn't reflow when switching scenes (they're all 940x560 in our
    // pipeline, but be defensive).
    const firstScene = scenes[0];
    stage.style.aspectRatio = `${firstScene.sourceW} / ${firstScene.sourceH}`;

    const img = document.createElement("img");
    img.className = "demo-img";
    img.alt = "Relit photograph";
    img.draggable = false;
    stage.appendChild(img);

    const ring = document.createElement("div");
    ring.className = "cursor-ring";
    stage.appendChild(ring);

    // ---- Controls ----
    const controls = document.createElement("div");
    controls.className = "demo-controls";

    // Scene group (only show if more than one scene).
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

    // Preset group.
    const presetGroup = document.createElement("div");
    presetGroup.className = "demo-group";
    const presetLbl = document.createElement("span");
    presetLbl.className = "demo-group-label";
    presetLbl.textContent = "Light";
    presetGroup.appendChild(presetLbl);
    // Buttons get rebuilt when the scene changes (in case presets differ
    // between scenes), so just leave a placeholder span here for now.
    const presetButtonsHolder = document.createElement("span");
    presetButtonsHolder.id = "preset-buttons";
    presetGroup.appendChild(presetButtonsHolder);
    controls.appendChild(presetGroup);

    mount.appendChild(stage);
    mount.appendChild(controls);

    // ---- Wire up input ----
    setupInput(stage, img, ring);

    // Kick things off with scene 0, preset 0.
    selectScene(0);
  }

  // ============================================================
  // Scene / preset selection
  // ============================================================

  function selectScene(idx) {
    if (idx < 0 || idx >= scenes.length) return;
    currentSceneIdx = idx;
    const scene = scenes[idx];

    // Highlight the active scene thumbnail.
    document.querySelectorAll(".demo-btn.scene-btn").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.idx) === idx);
    });

    // Rebuild preset buttons.
    const holder = document.getElementById("preset-buttons");
    holder.innerHTML = "";
    scene.presetUI.forEach((p, pi) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "demo-btn preset-btn";
      btn.textContent = p.label;
      btn.dataset.preset = p.name;
      btn.addEventListener("click", () => selectPreset(p.name));
      holder.appendChild(btn);
    });

    // Default preset: keep the current one if this scene supports it,
    // otherwise pick the first available.
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
    // Show the center cell first.
    const scene = scenes[currentSceneIdx];
    const u = Math.floor(scene.gridW / 2);
    const v = Math.floor(scene.gridH / 2);
    setImageToCell(u, v);
    // Kick off sparse skeleton prefetch for this (scene, preset).
    prefetchSkeleton(scene, name);
  }

  // ============================================================
  // Image swap on pointer move
  // ============================================================

  function setImageToCell(u, v) {
    const scene = scenes[currentSceneIdx];
    const url = cellURL(scene.id, currentPreset, u, v);
    if (url === currentSrc) return;
    currentSrc = url;
    const img = mount.querySelector(".demo-img");
    if (img) img.src = url;
  }

  // ============================================================
  // Mouse / touch input
  // ============================================================

  function setupInput(stage, img, ring) {
    function pointerToCell(clientX, clientY) {
      const rect = stage.getBoundingClientRect();
      let x = (clientX - rect.left) / rect.width;
      let y = (clientY - rect.top) / rect.height;
      // Clamp into the rendered grid range, accounting for margin.
      const scene = scenes[currentSceneIdx];
      const m = scene.margin || 0.05;
      x = Math.max(m, Math.min(1 - m, x));
      y = Math.max(m, Math.min(1 - m, y));
      // Map [m, 1-m] linearly to [0, gridW-1].
      const ux = (x - m) / (1 - 2 * m);
      const vy = (y - m) / (1 - 2 * m);
      return {
        u: clampInt(ux * (scene.gridW - 1), 0, scene.gridW - 1),
        v: clampInt(vy * (scene.gridH - 1), 0, scene.gridH - 1),
        screenX: clientX - rect.left,
        screenY: clientY - rect.top,
      };
    }

    // throttle to once per animation frame
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

    // Touch: drag-to-position.
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
      // Keep showing the last position; just hide the ring.
      stage.classList.remove("touch-active");
    });
  }

  // ============================================================
  // Skeleton prefetch
  // ============================================================

  function prefetchSkeleton(scene, preset) {
    const key = `${scene.id}::${preset}`;
    if (skeletonPreloaded.has(key)) return;
    skeletonPreloaded.add(key);

    // Every 4th cell. For a 32x32 grid: 8 × 8 = 64 cells ≈ 200 MB.
    // Could be tuned, but this gives the cursor "anchors" everywhere
    // while remaining responsive on page load.
    const stride = 4;
    const urls = [];
    for (let u = 0; u < scene.gridW; u += stride) {
      for (let v = 0; v < scene.gridH; v += stride) {
        urls.push(cellURL(scene.id, preset, u, v));
      }
    }
    // Don't preload more than ~80 cells per scene to stay bandwidth-polite.
    const capped = urls.slice(0, 80);
    capped.forEach(preload);
  }

  // ============================================================
  // Go
  // ============================================================

  bootstrap();
})();