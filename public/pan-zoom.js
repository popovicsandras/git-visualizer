// Pan / pinch / zoom for the graph panels, built on pointer + wheel events
// (no library needed).
//
// The panels share horizontal pan and zoom so a commit stays at the same x in
// "local" and "remote"; vertical pan is per panel.
//
// Gestures:
//   drag (mouse / one finger)          pan
//   two-finger trackpad scroll / wheel pan  (shift+wheel = horizontal)
//   trackpad pinch, ctrl/cmd + wheel    zoom around the cursor
//   two-finger touch pinch              zoom + pan
//   Safari trackpad pinch (gesture*)    zoom
//   double-click empty space            fit everything

const MIN_K = 0.2;
const MAX_K = 3;
const KEEP = 60; // px of content that must stay visible when panning
const DRAG_THRESHOLD = 4;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class LinkedPanZoom {
  constructor(containers, { onChange } = {}) {
    this.k = 1;
    this.tx = 0;
    this.onChange = onChange;
    this.views = containers.map((el) => ({ el, ty: 0, cw: 0, ch: 0, root: null }));
    for (const v of this.views) this.#bind(v);
    // Re-settle whenever a panel changes size (window resize, panel height split, etc.).
    const ro = new ResizeObserver(() => this.follow());
    for (const v of this.views) ro.observe(v.el);
    window.addEventListener('resize', () => this.follow());
  }

  /** Called after each render with the new root <g> and content size. */
  setContent(index, root, cw, ch) {
    Object.assign(this.views[index], { root, cw, ch });
    this.apply();
  }

  apply() {
    this.#clamp();
    for (const v of this.views) {
      v.root?.setAttribute('transform', `translate(${this.tx},${v.ty}) scale(${this.k})`);
    }
    this.onChange?.(this.k);
  }

  #clamp() {
    const views = this.views.filter((v) => v.root && v.el.clientWidth && v.el.clientHeight);
    if (!views.length) return;
    let lo = -Infinity;
    let hi = Infinity;
    for (const v of views) {
      lo = Math.max(lo, KEEP - v.cw * this.k);
      hi = Math.min(hi, v.el.clientWidth - KEEP);
    }
    this.tx = lo > hi ? hi : clamp(this.tx, lo, hi);
    for (const v of views) {
      const vlo = KEEP - v.ch * this.k;
      const vhi = v.el.clientHeight - KEEP;
      v.ty = vlo > vhi ? vhi : clamp(v.ty, vlo, vhi);
    }
  }

  /** Zoom by `factor` keeping the point (px, py) of view `v` fixed. */
  zoomAt(v, px, py, factor) {
    const k2 = clamp(this.k * factor, MIN_K, MAX_K);
    const f = k2 / this.k;
    if (f === 1) return;
    this.tx = px - (px - this.tx) * f;
    for (const w of this.views) {
      const ay = w === v ? py : 0;
      w.ty = ay - (ay - w.ty) * f;
    }
    this.k = k2;
    this.apply();
  }

  /** Zoom around the centre of the first panel (for the +/- buttons). */
  zoomBy(factor) {
    const v = this.views[0];
    this.zoomAt(v, v.el.clientWidth / 2, 0, factor);
  }

  panBy(v, dx, dy) {
    this.tx += dx;
    v.ty += dy;
    this.apply();
  }

  reset() {
    this.k = 1;
    this.tx = 0;
    for (const v of this.views) v.ty = 0;
    this.apply();
  }

  /** Scale so every panel's whole graph is visible. */
  fit() {
    let k = 1;
    for (const v of this.views) {
      if (!v.cw || !v.ch) continue;
      k = Math.min(k, (v.el.clientWidth - 16) / v.cw, (v.el.clientHeight - 8) / v.ch);
    }
    this.k = clamp(k, MIN_K, 1);
    this.tx = 8;
    for (const v of this.views) v.ty = 0;
    this.apply();
  }

  /** After a command: make sure the newest (rightmost) commits are in view. */
  follow() {
    if (!this.views.every((v) => v.el.clientWidth)) return;
    const vw = Math.min(...this.views.map((v) => v.el.clientWidth));
    const right = Math.max(...this.views.map((v) => v.cw)) * this.k;
    if (right + 8 <= vw) this.tx = Math.max(this.tx, 0); // everything fits: don't leave it cut off on the left
    if (this.tx + right > vw) this.tx = vw - right - 8;
    this.apply();
  }

  #local(v, e) {
    const r = v.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  #bind(v) {
    const el = v.el;

    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
        let dx = e.deltaX * unit;
        let dy = e.deltaY * unit;
        if (e.ctrlKey || e.metaKey) {
          // Trackpad pinch arrives as ctrl+wheel in Chromium/Firefox.
          const [px, py] = this.#local(v, e);
          this.zoomAt(v, px, py, Math.exp(-clamp(dy, -50, 50) * 0.01));
        } else {
          if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
          this.panBy(v, -dx, -dy);
        }
      },
      { passive: false },
    );

    // Safari's trackpad pinch.
    let gestureScale = 1;
    el.addEventListener('gesturestart', (e) => {
      e.preventDefault();
      gestureScale = 1;
    });
    el.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      const [px, py] = this.#local(v, e);
      this.zoomAt(v, px, py, e.scale / gestureScale);
      gestureScale = e.scale;
    });

    // Drag to pan, two pointers to pinch.
    const pts = new Map();
    let moved = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (!pts.size) moved = 0;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.classList.add('dragging');
    });
    window.addEventListener('pointermove', (e) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      if (pts.size === 1) {
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > DRAG_THRESHOLD) this.panBy(v, dx, dy);
      } else if (pts.size === 2) {
        const other = [...pts.entries()].find(([id]) => id !== e.pointerId)[1];
        const c1 = [(p.x + other.x) / 2, (p.y + other.y) / 2];
        const d1 = Math.hypot(p.x - other.x, p.y - other.y) || 1;
        const c2 = [(e.clientX + other.x) / 2, (e.clientY + other.y) / 2];
        const d2 = Math.hypot(e.clientX - other.x, e.clientY - other.y) || 1;
        const r = el.getBoundingClientRect();
        moved += DRAG_THRESHOLD + 1;
        this.zoomAt(v, c2[0] - r.left, c2[1] - r.top, d2 / d1);
        this.panBy(v, c2[0] - c1[0], c2[1] - c1[1]);
      }
      p.x = e.clientX;
      p.y = e.clientY;
    });
    const release = (e) => {
      pts.delete(e.pointerId);
      if (!pts.size) el.classList.remove('dragging');
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);

    // A drag must not count as a click on a commit.
    el.addEventListener(
      'click',
      (e) => {
        if (moved > DRAG_THRESHOLD) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true,
    );

    el.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.node')) this.fit();
    });
  }
}
