/* ========================================================================
   Qualitative comparison panel.

   Reads <site_root>/comparison_config.json. For each scene, expects four
   JPGs under <assets_root>/comparisons/<scene_id>/:
     ours_relit.jpg + one per baseline.name from the config

   Renders a scene picker plus one image-slider per baseline; each slider
   wipes between the baseline (left) and ours (right).
   ======================================================================== */

(function () {
  "use strict";

  // Inherits the assets_root prefix from site_config.json (shared with
  // demo.js). Comparison images live under <assets_root>/comparisons/.
  let ROOT = "./web_assets/comparisons";

  const mount = document.getElementById("comparison-mount");
  if (!mount) return;

  let cfg = null;
  let currentSceneIdx = 0;

  async function fetchJSON(url) {
    // Default cache policy (respects server Cache-Control) so config
    // edits are picked up without a hard browser refresh. Images use
    // force-cache separately — see the demo image preload path.
    const res = await fetch(url);
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

  function buildSliderBlock(sceneId, baseline, ours) {
    const block = document.createElement("div");
    block.className = "cmp-block";

    const label = document.createElement("p");
    label.className = "cmp-label";
    label.textContent = `${baseline.label} vs ${ours.label}`;
    block.appendChild(label);

    const stage = document.createElement("div");
    stage.className = "cmp-stage";

    const baseImg = document.createElement("img");
    baseImg.className = "cmp-base";
    baseImg.alt = `${ours.label} result`;
    baseImg.src = imageURL(sceneId, ours.name);
    baseImg.draggable = false;
    stage.appendChild(baseImg);

    const overlayImg = document.createElement("img");
    overlayImg.className = "cmp-overlay";
    overlayImg.alt = `${baseline.label} result`;
    overlayImg.src = imageURL(sceneId, baseline.name);
    overlayImg.draggable = false;
    stage.appendChild(overlayImg);

    const leftTag = document.createElement("div");
    leftTag.className = "cmp-tag cmp-tag-left";
    leftTag.textContent = baseline.label;
    stage.appendChild(leftTag);

    const rightTag = document.createElement("div");
    rightTag.className = "cmp-tag cmp-tag-right";
    rightTag.textContent = ours.label;
    stage.appendChild(rightTag);

    const handle = document.createElement("div");
    handle.className = "cmp-handle";
    stage.appendChild(handle);

    stage.style.aspectRatio = "940 / 560";
    baseImg.addEventListener("load", () => {
      if (baseImg.naturalWidth && baseImg.naturalHeight) {
        stage.style.aspectRatio = `${baseImg.naturalWidth} / ${baseImg.naturalHeight}`;
      }
    });

    let frac = 0.5;
    applyFrac();
    function applyFrac() {
      const pct = Math.max(0, Math.min(1, frac)) * 100;
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

    stage.addEventListener("mousedown", (e) => {
      dragging = true;
      onMoveAny(e.clientX);
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (dragging) onMoveAny(e.clientX);
    });
    window.addEventListener("mouseup", () => { dragging = false; });
    stage.addEventListener("mousemove", (e) => {
      if (!dragging) onMoveAny(e.clientX);
    });

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

  function render() {
    mount.innerHTML = "";

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
        const thumb = document.createElement("img");
        thumb.src = `${ROOT}/${s.scene_id}/${cfg.ours.name}.jpg`;
        thumb.alt = "";
        btn.appendChild(thumb);
        btn.addEventListener("click", () => selectScene(i));
        row.appendChild(btn);
      });
      mount.appendChild(row);
    }

    const blocksHolder = document.createElement("div");
    blocksHolder.id = "cmp-blocks";
    blocksHolder.style.display = "flex";
    blocksHolder.style.flexDirection = "column";
    blocksHolder.style.gap = "2rem";
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

  async function bootstrap() {
    // Inherit assets_root from site_config.json.
    try {
      const site = await fetchJSON("site_config.json");
      if (typeof site.assets_root === "string" && site.assets_root.length > 0) {
        ROOT = site.assets_root.replace(/\/+$/, "") + "/comparisons";
      }
    } catch (err) {
      console.warn("site_config.json not loaded; using default ROOT:", err.message);
    }

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