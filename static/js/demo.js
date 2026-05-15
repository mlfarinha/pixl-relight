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
  const skeletonPreloaded = new Set();
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

    const img = document.createElement("img");
    img.className = "demo-img";
    img.alt = "Relit photograph";
    img.draggable = false;
    stage.appendChild(img);

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

    setupInput(stage, img, ring);

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
    prefetchSkeleton(scene, name);
  }

  function setImageToCell(u, v) {
    const scene = scenes[currentSceneIdx];
    const url = cellURL(scene.id, currentPreset, u, v);
    if (url === currentSrc) return;
    currentSrc = url;
    const img = mount.querySelector(".demo-img");
    if (img) img.src = url;
  }

  function setupInput(stage, img, ring) {
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

  function prefetchSkeleton(scene, preset) {
    const key = `${scene.id}::${preset}`;
    if (skeletonPreloaded.has(key)) return;
    skeletonPreloaded.add(key);

    const stride = 4;
    const urls = [];
    for (let u = 0; u < scene.gridW; u += stride) {
      for (let v = 0; v < scene.gridH; v += stride) {
        urls.push(cellURL(scene.id, preset, u, v));
      }
    }
    urls.slice(0, 80).forEach(preload);
  }

  bootstrap();
})();