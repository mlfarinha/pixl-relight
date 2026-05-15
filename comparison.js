/* ========================================================================
   Qualitative comparison panel.

   Reads comparison_config.json:
     {
       "scenes": [
         { "scene_id": "<id>", "label": "..." },
         ...
       ],
       "baselines": [
         { "name": "ouroboros_relit", "label": "Ouroboros" },
         { "name": "vrgbx_relit",     "label": "V-RGB-X" },
         { "name": "blender_relit",   "label": "Blender (path-traced)" }
       ],
       "ours": { "name": "ours_relit", "label": "Ours" }
     }

   For each scene, expects files under <root>/<scene_id>/:
     ours_relit.jpg
     <each baseline.name>.jpg

   Layout: scene picker at top, then one image-slider block per baseline,
   each comparing that baseline (left side) against ours (right side).
   ======================================================================== */

(function () {
  "use strict";

  // Loaded from site_config.json at boot. The comparisons live under a
  // `comparisons/` subdir of the assets root.
  let ROOT = "../web_assets/comparisons";

  const mount = document.getElementById("comparison-mount");
  if (!mount) return;

  let cfg = null;
  let currentSceneIdx = 0;

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
    return res.json();
  }

  function showError(msg) {
    mount.innerHTML = "";
    const el = document.createElement("div");
    el.className = "demo-loading";
    el.textContent = `Failed to load comparisons: ${msg}`;
    mount.appendChild(el);
  }

  function imageURL(sceneId, fname) {
    return `${ROOT}/${sceneId}/${fname}.jpg`;
  }

  // ============================================================
  // Slider block
  // ============================================================
  /**
   * Build one image-slider comparing `baselineName` (left, clipped overlay)
   * against `oursName` (right, base image).
   *
   * Returns the root element. The slider handle and clip-path are updated
   * by pointer/touch handlers attached here.
   */
  function buildSliderBlock(sceneId, baseline, ours) {
    const block = document.createElement("div");
    block.className = "cmp-block";

    const label = document.createElement("p");
    label.className = "cmp-label";
    label.textContent = `${baseline.label} vs ${ours.label}`;
    block.appendChild(label);

    const stage = document.createElement("div");
    stage.className = "cmp-stage";

    // Base (right): ours
    const baseImg = document.createElement("img");
    baseImg.className = "cmp-base";
    baseImg.alt = `${ours.label} relit result`;
    baseImg.src = imageURL(sceneId, ours.name);
    baseImg.draggable = false;
    stage.appendChild(baseImg);

    // Overlay (left): baseline, clipped via inline clip-path
    const overlayImg = document.createElement("img");
    overlayImg.className = "cmp-overlay";
    overlayImg.alt = `${baseline.label} relit result`;
    overlayImg.src = imageURL(sceneId, baseline.name);
    overlayImg.draggable = false;
    stage.appendChild(overlayImg);

    // Corner tags
    const leftTag = document.createElement("div");
    leftTag.className = "cmp-tag cmp-tag-left";
    leftTag.textContent = baseline.label;
    stage.appendChild(leftTag);

    const rightTag = document.createElement("div");
    rightTag.className = "cmp-tag cmp-tag-right";
    rightTag.textContent = ours.label;
    stage.appendChild(rightTag);

    // Handle (the vertical line + grip)
    const handle = document.createElement("div");
    handle.className = "cmp-handle";
    stage.appendChild(handle);

    // Make the stage maintain the base image's aspect ratio so the page
    // doesn't reflow when the image loads. Use 940/560 (DL3DV native) as
    // a default until the real image dimensions are known.
    stage.style.aspectRatio = "940 / 560";
    baseImg.addEventListener("load", () => {
      if (baseImg.naturalWidth && baseImg.naturalHeight) {
        stage.style.aspectRatio = `${baseImg.naturalWidth} / ${baseImg.naturalHeight}`;
      }
    });

    // ---- Slider position state + pointer handling ----
    // `frac` is the fraction of the overlay visible from the left edge.
    // 0 = overlay fully clipped (only base visible). 1 = overlay fully visible.
    // Initial state: 50/50.
    let frac = 0.5;
    applyFrac();

    function applyFrac() {
      const pct = Math.max(0, Math.min(1, frac)) * 100;
      // clip-path inset: from the right side hide (100 - pct)% so the
      // visible left portion is pct%.
      overlayImg.style.clipPath = `inset(0 ${(100 - pct).toFixed(2)}% 0 0)`;
      handle.style.left = `${pct.toFixed(2)}%`;
    }

    let dragging = false;
    function pointerToFrac(clientX) {
      const rect = stage.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }
    function onMoveAny(clientX) {
      frac = pointerToFrac(clientX);
      applyFrac();
    }

    // Mouse: support both click-to-jump and click-and-drag.
    stage.addEventListener("mousedown", (e) => {
      dragging = true;
      onMoveAny(e.clientX);
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (dragging) onMoveAny(e.clientX);
    });
    window.addEventListener("mouseup", () => { dragging = false; });
    // Hover-only mode is also nice: just track the mouse, no click needed.
    // This makes exploring the comparison feel responsive.
    stage.addEventListener("mousemove", (e) => {
      if (!dragging) onMoveAny(e.clientX);
    });

    // Touch
    stage.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      if (t) { dragging = true; onMoveAny(t.clientX); }
    }, { passive: true });
    stage.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (t && dragging) onMoveAny(t.clientX);
    }, { passive: true });
    stage.addEventListener("touchend", () => { dragging = false; });

    block.appendChild(stage);
    return block;
  }

  // ============================================================
  // Scene picker + render
  // ============================================================
  function render() {
    mount.innerHTML = "";

    // Scene picker row.
    if (cfg.scenes.length > 1) {
      const row = document.createElement("div");
      row.className = "comparison-scene-row";

      const lbl = document.createElement("span");
      lbl.className = "demo-group-label";
      lbl.textContent = "Scene";
      row.appendChild(lbl);

      cfg.scenes.forEach((s, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "demo-btn scene-btn";
        btn.setAttribute("aria-label", s.label);
        btn.title = s.label;
        btn.dataset.idx = i;
        // Use the source image from the demo's web_assets as thumbnail; the
        // comparisons/<scene>/ folder typically doesn't carry one.
        const thumb = document.createElement("img");
        thumb.src = `${ROOT}/${s.scene_id}/${cfg.ours.name}.jpg`;
        thumb.alt = "";
        btn.appendChild(thumb);
        btn.addEventListener("click", () => selectScene(i));
        row.appendChild(btn);
      });

      mount.appendChild(row);
    }

    // Slider blocks container — populated by selectScene.
    const blocksHolder = document.createElement("div");
    blocksHolder.id = "cmp-blocks";
    blocksHolder.style.display = "flex";
    blocksHolder.style.flexDirection = "column";
    blocksHolder.style.gap = "32px";
    mount.appendChild(blocksHolder);

    selectScene(0);
  }

  function selectScene(idx) {
    if (idx < 0 || idx >= cfg.scenes.length) return;
    currentSceneIdx = idx;
    const scene = cfg.scenes[idx];

    document.querySelectorAll("#comparison-mount .scene-btn").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.idx) === idx);
    });

    const holder = document.getElementById("cmp-blocks");
    holder.innerHTML = "";
    cfg.baselines.forEach((baseline) => {
      const block = buildSliderBlock(scene.scene_id, baseline, cfg.ours);
      holder.appendChild(block);
    });
  }

  // ============================================================
  // Boot
  // ============================================================
  async function bootstrap() {
    // 1. Resolve assets_root from site_config.json (shared with demo.js).
    try {
      const site = await fetchJSON("site_config.json");
      if (typeof site.assets_root === "string" && site.assets_root.length > 0) {
        ROOT = site.assets_root.replace(/\/+$/, "") + "/comparisons";
      }
    } catch (err) {
      console.warn("site_config.json not loaded; using default ROOT:", err.message);
    }

    // 2. Load the comparison config.
    try {
      const configURL = mount.dataset.config || "comparison_config.json";
      cfg = await fetchJSON(configURL);

      if (!Array.isArray(cfg.scenes) || cfg.scenes.length === 0) {
        throw new Error("comparison_config.json: `scenes` is empty");
      }
      if (!Array.isArray(cfg.baselines) || cfg.baselines.length === 0) {
        throw new Error("comparison_config.json: `baselines` is empty");
      }
      if (!cfg.ours || !cfg.ours.name) {
        throw new Error("comparison_config.json: `ours` is missing");
      }
    } catch (err) {
      showError(err.message);
      return;
    }
    render();
  }

  bootstrap();
})();