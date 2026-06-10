/* ──────────────────────────────────────────────────────────────────
   Vertebrae · Hearth — shared pan/zoom hook (plain JS, uses global React)
   usePanZoom(containerRef, content, opts) →
     { transform, scale, fit, zoomIn, zoomOut, reset }
   • drag anywhere on the container to pan (except [data-no-pan] elements)
   • wheel / trackpad-pinch to zoom, anchored at the cursor
   • fit() centers + scales content {w,h} into the container
   Apply `transform` (with transform-origin:0 0) to the content wrapper.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function usePanZoom(ref, content, opts) {
    opts = opts || {};
    const { useState, useRef, useEffect, useMemo } = React;
    const min = opts.min || 0.15, max = opts.max || 2.4, pad = opts.pad == null ? 96 : opts.pad;
    const [t, setT] = useState({ s: opts.scale || 1, x: 0, y: 0 });
    const tref = useRef(t); tref.current = t;
    const contentRef = useRef(content); contentRef.current = content;
    const moved = useRef(false); // becomes true once the user pans/zooms — stops auto-fit

    // listeners (pointer drag + non-passive wheel)
    useEffect(() => {
      const el = ref.current; if (!el) return;
      let drag = null;
      const down = (e) => {
        if (e.button !== 0) return;
        if (e.target.closest && e.target.closest('[data-no-pan]')) return;
        drag = { x: e.clientX, y: e.clientY, ox: tref.current.x, oy: tref.current.y };
        el.classList.add('is-grabbing');
      };
      const move = (e) => {
        if (!drag) return;
        moved.current = true;
        const ox = drag.ox, oy = drag.oy, sx = drag.x, sy = drag.y;
        setT((p) => ({ ...p, x: ox + (e.clientX - sx), y: oy + (e.clientY - sy) }));
      };
      const up = () => { drag = null; el.classList.remove('is-grabbing'); };
      const wheel = (e) => {
        e.preventDefault();
        moved.current = true;
        const r = el.getBoundingClientRect();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        setT((p) => {
          const f = Math.exp(-e.deltaY * 0.0016);
          const ns = clamp(p.s * f, min, max);
          const k = ns / p.s;
          return { s: ns, x: px - (px - p.x) * k, y: py - (py - p.y) * k };
        });
      };
      el.addEventListener('pointerdown', down);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      el.addEventListener('wheel', wheel, { passive: false });
      return () => {
        el.removeEventListener('pointerdown', down);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        el.removeEventListener('wheel', wheel);
      };
    }, [ref]);

    const api = useMemo(() => {
      const zoomCenter = (factor) => {
        const el = ref.current; if (!el) return;
        const px = el.clientWidth / 2, py = el.clientHeight / 2;
        setT((p) => { const ns = clamp(p.s * factor, min, max); const k = ns / p.s; return { s: ns, x: px - (px - p.x) * k, y: py - (py - p.y) * k }; });
      };
      const fit = () => {
        const el = ref.current, c = contentRef.current; if (!el || !c) return;
        const cw = el.clientWidth, ch = el.clientHeight;
        if (cw < 2 || ch < 2) return; // canvas not sized yet — wait for the ResizeObserver
        const s = clamp(Math.min((cw - pad) / c.w, (ch - pad) / c.h), min, max);
        setT({ s, x: (cw - c.w * s) / 2, y: (ch - c.h * s) / 2 });
      };
      // centerOn(cx, cy, opts) — bring a content-space point to a viewport anchor.
      //   opts.scale  target scale (clamped); defaults to current
      //   opts.ax/ay  viewport anchor in px; defaults to the container centre
      const centerOn = (cx, cy, opts) => {
        const el = ref.current; if (!el) return;
        opts = opts || {};
        moved.current = true; // user-directed — stop auto-fit fighting it
        setT((p) => {
          const s = clamp(opts.scale != null ? opts.scale : p.s, min, max);
          const ax = opts.ax != null ? opts.ax : el.clientWidth / 2;
          const ay = opts.ay != null ? opts.ay : el.clientHeight / 2;
          return { s, x: ax - cx * s, y: ay - cy * s };
        });
      };
      return { fit: () => { moved.current = false; fit(); }, _autofit: fit, zoomIn: () => zoomCenter(1.18), zoomOut: () => zoomCenter(1 / 1.18), reset: () => setT({ s: 1, x: 0, y: 0 }), centerOn };
    }, [ref]);

    // Auto-fit once the container actually has a size, and on resize — until the
    // user takes control. Fixes the first-paint case where fit() ran against a
    // not-yet-laid-out (zero/low-height) canvas and clamped to the min scale.
    useEffect(() => {
      const el = ref.current; if (!el || typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(() => { if (!moved.current) api._autofit(); });
      ro.observe(el);
      return () => ro.disconnect();
    }, [ref]);

    return { transform: `translate(${t.x}px,${t.y}px) scale(${t.s})`, scale: t.s, ...api };
  }

  window.usePanZoom = usePanZoom;
})();
