/* ──────────────────────────────────────────────────────────────────
   Vertebrae · Hearth — ELK layout helper (shared)
   Turns window.WFGraph (data) into positioned geometry for both pages.

     WFElk.layoutFull(data)       → nested: workflow containers ⊃ step nodes,
                                     orthogonal step + cross-workflow routing.
                                     Used by the GRAPH (topology) page.

     WFElk.layoutCondensed(data)  → workflow-only graph (step edges aggregated
                                     up to workflow→workflow). ELK layers become
                                     value-stream columns. Used by the ATLAS page.

   Coordinate spaces (handled here, callers get absolute px):
     • workflow nodes        → root-relative (absolute)
     • step nodes            → relative to their workflow (we add the offset)
     • cross-workflow edges  → declared at root → already absolute
     • intra/loop edges      → declared in their container → we add the offset
   ────────────────────────────────────────────────────────────────── */
(function () {
  function approxLabelW(t) { return Math.max(28, t.length * 6.0 + 10); }

  function splitRef(ref) { const i = ref.indexOf('.'); return [ref.slice(0, i), ref.slice(i + 1)]; }

  function edgePoints(e, ox, oy) {
    const sec = e.sections && e.sections[0];
    const pts = [];
    if (sec) {
      pts.push(sec.startPoint);
      (sec.bendPoints || []).forEach((p) => pts.push(p));
      pts.push(sec.endPoint);
    }
    return pts.map((p) => ({ x: p.x + ox, y: p.y + oy }));
  }
  function edgeLabel(e, ox, oy) {
    const l = e.labels && e.labels[0];
    return l ? { text: l.text, x: l.x + ox + (l.width || 0) / 2, y: l.y + oy + (l.height || 0) / 2 } : null;
  }

  /* ── edge↔box anchoring ─────────────────────────────────────
     ELK (and the hub overlay) can hand back cross-edge endpoints that sit
     at a container's center or trail under its box. Re-anchor both ends
     onto the workflow's bounding-box border so every transition visibly
     enters/leaves the box edge, never its interior. */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function inBox(p, b, pad) { pad = pad || 0; return p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad; }
  // intersection of the ray (cx,cy)->(tx,ty) with box b's border
  function rayBox(cx, cy, tx, ty, b) {
    const dx = tx - cx, dy = ty - cy;
    let t = Infinity;
    if (dx > 0) t = Math.min(t, (b.x + b.w - cx) / dx);
    else if (dx < 0) t = Math.min(t, (b.x - cx) / dx);
    if (dy > 0) t = Math.min(t, (b.y + b.h - cy) / dy);
    else if (dy < 0) t = Math.min(t, (b.y - cy) / dy);
    if (!isFinite(t) || t < 0) t = 0;
    return { x: cx + dx * t, y: cy + dy * t };
  }
  // anchor one end to box b, given the neighbouring point nb (assumed outside b).
  // Keeps an orthogonal approach when nb lines up with a face; else trims to border.
  function borderAnchor(b, nb) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (nb.x >= b.x && nb.x <= b.x + b.w) return { x: clamp(nb.x, b.x, b.x + b.w), y: nb.y <= cy ? b.y : b.y + b.h }; // vertical approach
    if (nb.y >= b.y && nb.y <= b.y + b.h) return { x: nb.x <= cx ? b.x : b.x + b.w, y: clamp(nb.y, b.y, b.y + b.h) }; // horizontal approach
    return rayBox(cx, cy, nb.x, nb.y, b); // diagonal
  }
  // drop points buried inside either endpoint box, then snap both ends to the borders
  function anchorEdge(pts, A, B) {
    if (!pts || pts.length < 2) return pts;
    let s = 0, e = pts.length - 1;
    while (s < e - 1 && inBox(pts[s + 1], A)) s++;
    while (e > s + 1 && inBox(pts[e - 1], B)) e--;
    const out = pts.slice(s, e + 1);
    out[0] = borderAnchor(A, out[1]);
    out[out.length - 1] = borderAnchor(B, out[out.length - 2]);
    return out;
  }

  /* ── FULL (nested) ── */
  async function layoutFull(data, opts) {
    opts = opts || {};
    const STEP_W = opts.stepW || 148, STEP_H = opts.stepH || 88, HEAD = opts.headH || 96;
    const elk = new ELK();

    const meta = {}; // edgeId -> { fromWf, toWf, kind, label }
    const containers = data.workflows.map((w) => {
      const node = {
        id: w.id,
        layoutOptions: {
          'elk.algorithm': 'layered', 'elk.direction': 'RIGHT',
          'elk.padding': `[top=${HEAD},left=20,bottom=40,right=20]`,
          'elk.spacing.nodeNode': '22',
          'elk.layered.spacing.nodeNodeBetweenLayers': '34',
          'elk.nodeSize.constraints': 'MINIMUM_SIZE',
          'elk.nodeSize.minimum': '(216.0,0.0)',
        },
        children: w.steps.map((st) => ({ id: w.id + '.' + st.id, width: STEP_W, height: STEP_H })),
        edges: [],
      };
      // forward step links (implied by order)
      for (let i = 0; i < w.steps.length - 1; i++) {
        node.edges.push({ id: `F_${w.id}_${i}`, sources: [w.id + '.' + w.steps[i].id], targets: [w.id + '.' + w.steps[i + 1].id] });
        meta[`F_${w.id}_${i}`] = { fromWf: w.id, toWf: w.id, kind: 'forward' };
      }
      return node;
    });
    const byId = Object.fromEntries(containers.map((c) => [c.id, c]));

    const rootEdges = [];
    const hubEdges = [];
    const loops = []; // intra-workflow loop-backs — NOT fed to ELK layout (kept out so step rows stay clean); drawn from step positions
    // Detect “hub” workflows (wired to most others, e.g. Human Review). Their cross
    // edges are drawn as a light overlay and kept OUT of the ELK layout, so a node
    // connected to everything doesn't inflate the board into a giant sparse canvas.
    const adj = {};
    data.edges.forEach((e) => { const [a] = splitRef(e.from), [b] = splitRef(e.to); if (a !== b) { (adj[a] = adj[a] || new Set()).add(b); (adj[b] = adj[b] || new Set()).add(a); } });
    const nW = data.workflows.length;
    const hubSet = new Set(Object.keys(adj).filter((id) => adj[id].size >= Math.max(4, Math.ceil((nW - 1) * 0.6))));
    const seen = {};
    data.edges.forEach((e, idx) => {
      const [fw] = splitRef(e.from), [tw] = splitRef(e.to);
      if (fw === tw) {
        loops.push({ id: 'L' + idx, wf: fw, from: e.from, to: e.to, label: e.label });
        return;
      }
      const id = 'X' + idx;
      const hub = hubSet.has(fw) || hubSet.has(tw);
      meta[id] = { fromWf: fw, toWf: tw, kind: 'cross', hub, label: e.label, fromStep: e.from, toStep: e.to };
      if (hub) {
        // overlay edge — not given to ELK
        hubEdges.push({ id, fromWf: fw, toWf: tw });
      } else {
        // cross edges route container→container (ELK routes top-level nodes reliably across hierarchy)
        rootEdges.push({ id, sources: [fw], targets: [tw], labels: e.label ? [{ text: e.label, width: approxLabelW(e.label), height: 13 }] : [] });
      }
    });

    const graph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered', 'elk.direction': 'DOWN',
        'elk.edgeRouting': 'POLYLINE',
        'elk.spacing.nodeNode': '64',
        'elk.layered.spacing.nodeNodeBetweenLayers': '120',
        'elk.layered.spacing.edgeNodeBetweenLayers': '34',
        'elk.spacing.edgeNode': '28', 'elk.spacing.edgeEdge': '20',
        'elk.layered.mergeEdges': 'true',
      },
      children: containers, edges: rootEdges,
    };

    const r = await elk.layout(graph);

    const workflows = r.children.map((c) => {
      const w = data.workflows.find((x) => x.id === c.id);
      const steps = (c.children || []).map((st) => {
        const [, sid] = splitRef(st.id);
        const def = w.steps.find((x) => x.id === sid);
        return { id: st.id, sid, name: def.name, kind: def.kind, role: def.role, x: c.x + st.x, y: c.y + st.y, w: st.width, h: st.height };
      });
      const intra = (c.edges || []).map((e) => ({
        id: e.id, ...meta[e.id], points: edgePoints(e, c.x, c.y), labelPos: edgeLabel(e, c.x, c.y),
      }));
      return { id: c.id, def: w, x: c.x, y: c.y, w: c.width, h: c.height, steps, intra };
    });

    // loop-backs: arc under the step row, computed from final step positions
    const wfById = Object.fromEntries(workflows.map((w) => [w.id, w]));
    const loopGeo = loops.map((lp) => {
      const w = wfById[lp.wf];
      const from = w.steps.find((s) => s.id === lp.from), to = w.steps.find((s) => s.id === lp.to);
      if (!from || !to) return null;
      const rowBottom = Math.max(...w.steps.map((s) => s.y + s.h));
      const lane = rowBottom + 18;
      const fx = from.x + from.w / 2, tx = to.x + to.w / 2;
      const points = [{ x: fx, y: from.y + from.h }, { x: fx, y: lane }, { x: tx, y: lane }, { x: tx, y: to.y + to.h }];
      return { id: lp.id, wf: lp.wf, kind: 'loop', label: lp.label, points, labelPos: { x: (fx + tx) / 2, y: lane } };
    }).filter(Boolean);
    workflows.forEach((w) => { w.intra = w.intra.concat(loopGeo.filter((l) => l.wf === w.id)); });

    const cross = (r.edges || []).map((e) => {
      const m = meta[e.id];
      const A = wfById[m.fromWf], B = wfById[m.toWf];
      let points = edgePoints(e, 0, 0);
      if (A && B) points = anchorEdge(points, A, B);
      return { id: e.id, ...m, points, labelPos: edgeLabel(e, 0, 0) };
    });

    // hub overlay edges: straight box-center → box-center, computed AFTER layout so
    // they never participate in (or distort) the ELK packing.
    const hubGeo = hubEdges.map((h) => {
      const a = wfById[h.fromWf], b = wfById[h.toWf];
      if (!a || !b) return null;
      const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      // anchor on each box border along the center→center line (never the interior)
      const p1 = rayBox(ca.x, ca.y, cb.x, cb.y, a);
      const p2 = rayBox(cb.x, cb.y, ca.x, ca.y, b);
      return { id: h.id, ...meta[h.id], points: [p1, p2], labelPos: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 } };
    }).filter(Boolean);

    return { width: r.width, height: r.height, workflows, cross: cross.concat(hubGeo), hubIds: [...hubSet] };
  }

  /* ── CONDENSED (workflow-only) — deterministic value-stream columns from data.phases.
        Positions derive from each workflow's `phase` (one column per phase, members
        stacked + centered). Edges routed orthogonally: verticals live in the column
        gaps, long horizontals in top/bottom corridors, so nothing crosses a card.
        (ELK isn't used here — its layered engine can't pin a phase to a single column
        when the phase has internal edges; the Graph page still uses ELK.) ── */
  async function layoutCondensed(data, opts) {
    opts = opts || {};
    const W = opts.boxW || 264, H = opts.boxH || 140;
    const COLGAP = 188, ROWGAP = 44, PADX = 100, PADTOP = 150, PADBOT = 120;

    // aggregate step edges → workflow→workflow
    const map = new Map();
    data.edges.forEach((e) => {
      const [fw] = splitRef(e.from), [tw] = splitRef(e.to);
      if (fw === tw) return;
      const k = fw + '>' + tw;
      if (!map.has(k)) map.set(k, { from: fw, to: tw, labels: [] });
      if (e.label && map.get(k).labels.indexOf(e.label) === -1) map.get(k).labels.push(e.label);
    });
    const conds = [...map.values()];

    // columns = phases (in declared order) that actually have members
    const phaseOrder = (data.phases || []).filter((p) => data.workflows.some((w) => w.phase === p));
    const colOfPhase = Object.fromEntries(phaseOrder.map((p, i) => [p, i]));
    const nCols = phaseOrder.length;
    const colX = (c) => PADX + c * (W + COLGAP);

    // members per column, stacked + vertically centered
    const members = phaseOrder.map((p) => data.workflows.filter((w) => w.phase === p));
    const blockH = (k) => k * H + (k - 1) * ROWGAP;
    const contentH = Math.max.apply(null, members.map((m) => blockH(m.length)));

    const nodes = [];
    members.forEach((list, c) => {
      const startY = PADTOP + (contentH - blockH(list.length)) / 2;
      list.forEach((w, k) => {
        const x = colX(c), y = startY + k * (H + ROWGAP);
        nodes.push({ id: w.id, def: w, phase: w.phase, col: c, x, y, w: W, h: H, cx: x + W / 2, cy: y + H / 2, left: x, right: x + W });
      });
    });
    const nById = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const width = colX(nCols - 1) + W + PADX;
    const height = PADTOP + contentH + PADBOT;

    // routing infrastructure
    const xGap = (g) => colX(g) + W + COLGAP / 2;       // vertical bus in the gap right of column g
    const topBase = 46, botBase = PADTOP + contentH + 34;
    let topK = 0, botK = 0; const leftK = {};

    const edges = conds.map((cd, i) => {
      const a = nById[cd.from], b = nById[cd.to];
      const ca = a.col, cb = b.col;
      let pts, lp;
      if (ca === cb) {                                    // same column → left side-bus
        const k = (leftK[ca] = (leftK[ca] || 0) + 1);
        const xL = colX(ca) - 26 - (k - 1) * 13;
        pts = [{ x: a.left, y: a.cy }, { x: xL, y: a.cy }, { x: xL, y: b.cy }, { x: b.left, y: b.cy }];
        lp = { x: xL, y: (a.cy + b.cy) / 2 };
      } else if (cb === ca + 1) {                          // adjacent forward → gap bus
        const bx = xGap(ca);
        pts = [{ x: a.right, y: a.cy }, { x: bx, y: a.cy }, { x: bx, y: b.cy }, { x: b.left, y: b.cy }];
        lp = { x: bx, y: (a.cy + b.cy) / 2 };
      } else if (cb > ca) {                                // distant forward → top corridor
        const lane = topBase + (topK++) * 16;
        const bxA = xGap(ca), bxB = xGap(cb - 1);
        pts = [{ x: a.right, y: a.cy }, { x: bxA, y: a.cy }, { x: bxA, y: lane }, { x: bxB, y: lane }, { x: bxB, y: b.cy }, { x: b.left, y: b.cy }];
        lp = { x: (bxA + bxB) / 2, y: lane };
      } else {                                             // backward → bottom corridor
        const lane = botBase + (botK++) * 16;
        const bxA = xGap(ca - 1), bxB = xGap(cb);
        pts = [{ x: a.left, y: a.cy }, { x: bxA, y: a.cy }, { x: bxA, y: lane }, { x: bxB, y: lane }, { x: bxB, y: b.cy }, { x: b.right, y: b.cy }];
        lp = { x: (bxA + bxB) / 2, y: lane };
      }
      return { id: 'C' + i, from: cd.from, to: cd.to, labels: cd.labels, points: pts, labelPos: lp };
    });

    const columns = phaseOrder.map((p, i) => ({
      i, x: colX(i), cx: colX(i) + W / 2, phase: p,
      members: members[i].map((w) => w.id), top: PADTOP,
    }));

    return { width: width + 60, height: height + 30, nodes, edges, columns };
  }

  window.WFElk = { layoutFull, layoutCondensed };
})();
