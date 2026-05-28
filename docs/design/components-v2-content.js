/* ──────────────────────────────────────────────────────────────────
   Hearth · Components v2 — Catalog content
   Builds long-form section HTML and injects into #catalogBody.
   ────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── Common pieces ──────────────────────────────────────────────
  function idChip(id) {
    return '<span class="c-id-chip" data-id="' + id + '" title="click to copy">' +
      '<span class="id-text">' + id + '</span>' +
      '<svg class="copy-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
      '<svg class="ok-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' +
      '</span>';
  }
  function runChip(state, label, runtime) {
    const spinner = state === 'running' ? '<span class="spinner"></span>' : '';
    return '<span class="c-run-chip ' + state + '">' + spinner + label +
      (runtime ? '<span class="runtime"> · ' + runtime + '</span>' : '') + '</span>';
  }
  function kindChip(kind) {
    const labels = { execute: 'execute', eval: 'eval', route: 'route', human: 'human review', wait: 'wait' };
    return '<span class="c-kind-chip kind-' + kind + '"><span class="swatch"></span>' + labels[kind] + '</span>';
  }
  function sectHeader(num, name, title, lede) {
    return '<section class="sect" id="' + name + '">' +
      '<div class="sect-num">§ ' + num + ' · ' + name + '</div>' +
      '<h2>' + title + '</h2>' +
      '<p class="lede">' + lede + '</p>';
  }

  // ── COLOR SYSTEM HELPERS (used by Foundations) ─────────────────
  const STEP_KINDS = [
    { id: 'execute', hue: 285, label: 'execute', note: 'agent runs code · does work' },
    { id: 'eval',    hue: 200, label: 'eval',    note: 'agent evaluates a result' },
    { id: 'route',   hue: 135, label: 'route',   note: 'routing · branching decision' },
    { id: 'human',   hue: 70,  label: 'human',   note: 'human must act' },
    { id: 'wait',    hue: 250, label: 'wait',    note: 'paused on subtasks · passive' },
  ];
  const STATUS_COLORS = [
    { id: 'ok',    hue: 145, label: 'ok',    note: 'completion · success' },
    { id: 'warn',  hue: 75,  label: 'warn',  note: 'caution · pending' },
    { id: 'err',   hue: 25,  label: 'err',   note: 'failure · cancellation' },
    { id: 'info',  hue: 220, label: 'info',  note: 'reference · neutral signal' },
  ];
  const ALL_HUES = [
    { id: 'accent',  hue: 40,  label: 'accent',  l: 0.74, c: 0.18, kind: 'brand',  anchor: true },
    { id: 'err',     hue: 25,  label: 'err',     l: 0.72, c: 0.18, kind: 'status', anchor: true },
    { id: 'human',   hue: 70,  label: 'human',   l: 0.80, c: 0.15, kind: 'step' },
    { id: 'warn',    hue: 75,  label: 'warn',    l: 0.78, c: 0.15, kind: 'status', anchor: true },
    { id: 'route',   hue: 135, label: 'route',   l: 0.82, c: 0.18, kind: 'step' },
    { id: 'ok',      hue: 145, label: 'ok',      l: 0.78, c: 0.15, kind: 'status', anchor: true },
    { id: 'eval',    hue: 200, label: 'eval',    l: 0.78, c: 0.13, kind: 'step' },
    { id: 'info',    hue: 220, label: 'info',    l: 0.78, c: 0.13, kind: 'status', anchor: true },
    { id: 'wait',    hue: 250, label: 'wait',    l: 0.62, c: 0.04, kind: 'step' },
    { id: 'execute', hue: 285, label: 'execute', l: 0.72, c: 0.16, kind: 'step' },
  ];

  function renderSurfaces() {
    const bgs = [
      { v: 'bg',   role: 'base' },
      { v: 'bg-1', role: 'surface 1' },
      { v: 'bg-2', role: 'surface 2' },
      { v: 'bg-3', role: 'surface 3' },
      { v: 'bg-4', role: 'surface 4' },
    ];
    const fgs = [
      { v: 'fg',        role: 'primary' },
      { v: 'fg-soft',   role: 'soft' },
      { v: 'fg-mute',   role: 'mute' },
      { v: 'fg-faint',  role: 'faint' },
      { v: 'fg-ghost',  role: 'ghost' },
    ];
    return (
      '<h3 style="margin-top: var(--s-7);">Surfaces &amp; ink <em style="font-family:var(--mono);font-size:10px;color:var(--fg-faint);font-style:normal;letter-spacing:0.06em;margin-left:8px;">warm neutrals</em></h3>' +
      '<div class="grid two">' +

        '<div class="card">' +
          '<div class="card-head"><div class="card-name">Backgrounds</div></div>' +
          '<div class="card-canvas" style="padding: 0; gap: 0;">' +
            '<div style="display: grid; grid-template-columns: repeat(5, 1fr); width: 100%;">' +
              bgs.map(b =>
                '<div style="height: 84px; background: var(--' + b.v + '); padding: 6px; display: flex; flex-direction: column; justify-content: space-between; border-right: 1px solid var(--line); font-family: var(--mono); font-size: 9px;">' +
                  '<span style="color: var(--fg-faint);">--' + b.v + '</span>' +
                  '<span style="color: var(--fg-mute);">' + b.role + '</span>' +
                '</div>'
              ).join('') +
            '</div>' +
          '</div>' +
          '<div class="card-foot">5-step warm dark ramp. <span class="rule">bg-1 for cards · bg-2 for nested · bg-3 for selected · bg-4 for highest elevation.</span></div>' +
        '</div>' +

        '<div class="card">' +
          '<div class="card-head"><div class="card-name">Ink</div></div>' +
          '<div class="card-canvas" style="padding: 0; gap: 0;">' +
            '<div style="display: grid; grid-template-columns: repeat(5, 1fr); width: 100%;">' +
              fgs.map(f =>
                '<div style="height: 84px; background: var(--bg-1); padding: 6px; display: flex; flex-direction: column; justify-content: space-between; border-right: 1px solid var(--line); font-family: var(--mono); font-size: 9px;">' +
                  '<span style="color: var(--' + f.v + '); font-family: var(--serif); font-style: italic; font-size: 16px;">Aa</span>' +
                  '<span style="color: var(--' + f.v + ');">--' + f.v + '</span>' +
                '</div>'
              ).join('') +
            '</div>' +
          '</div>' +
          '<div class="card-foot">5-step warm neutral ramp. <span class="rule">fg primary · fg-mute secondary · fg-faint metadata · fg-ghost separators.</span></div>' +
        '</div>' +

      '</div>'
    );
  }

  function renderAccent() {
    const variants = [
      { v: 'accent',       l: 0.74, c: 0.18, h: 40, role: 'primary · "now"' },
      { v: 'accent-deep',  l: 0.58, c: 0.18, h: 35, role: 'hover · pressed' },
      { v: 'accent-mute',  l: 0.52, c: 0.12, h: 38, role: 'subdued accent' },
      { v: 'accent-wash',  l: 0.22, c: 0.05, h: 38, role: 'background tint' },
    ];
    return (
      '<h3 style="margin-top: var(--s-7);">Hearthfire <em style="font-family:var(--mono);font-size:10px;color:var(--fg-faint);font-style:normal;letter-spacing:0.06em;margin-left:8px;">the accent · hue 40°</em></h3>' +
      '<p class="lede" style="font-size: 14px; margin-bottom: var(--s-3); max-width: 720px;">Four siblings around hue 40°. They give the accent agency without losing identity.</p>' +
      '<div class="card">' +
        '<div class="card-canvas" style="padding: var(--s-3); gap: var(--s-3); align-items: stretch;">' +
          variants.map(v =>
            '<div style="flex: 1; min-width: 130px; display: flex; flex-direction: column; gap: 6px;">' +
              '<div style="height: 84px; background: var(--' + v.v + '); border-radius: var(--r-sm); border: 1px solid var(--line);"></div>' +
              '<div style="font-family: var(--mono); font-size: 10.5px; color: var(--fg); letter-spacing: 0.02em;">--' + v.v + '</div>' +
              '<div style="font-family: var(--mono); font-size: 9px; color: var(--fg-faint);">oklch(' + v.l + ' ' + v.c + ' ' + v.h + ')</div>' +
              '<div style="font-family: var(--sans); font-size: 11px; color: var(--fg-mute);">' + v.role + '</div>' +
            '</div>'
          ).join('') +
        '</div>' +
        '<div class="card-foot"><b>--accent-glow:</b> rgba(230, 130, 80, 0.22) — for box-shadows on running things. <span class="rule">accent-deep / accent-mute exist for state changes only. Never as decoration.</span></div>' +
      '</div>'
    );
  }

  function tripletCard(family) {
    // family: { id, hue, label, note, varBase, fgVar }
    return (
      '<div class="card">' +
        '<div class="card-head">' +
          '<div class="card-name">' + family.varBase + ' <em style="color: var(--' + family.fgVar + '); margin-left: 0;">' + family.note + '</em></div>' +
          (family.anchored
            ? '<span style="font-family: var(--mono); font-size: 9px; color: var(--fg-faint); padding: 2px 6px; border: 1px solid var(--line-strong); border-radius: var(--r-xs); letter-spacing: 0.1em; white-space: nowrap;">⚓ anchored</span>'
            : '<span style="font-family: var(--mono); font-size: 9px; color: var(--fg-faint); padding: 2px 6px; border: 1px solid var(--line-strong); border-radius: var(--r-xs); letter-spacing: 0.1em; white-space: nowrap;">' + family.hue + '°</span>'
          ) +
        '</div>' +
        '<div class="card-canvas" style="padding: 0; gap: 0;">' +
          '<div style="display: grid; grid-template-columns: 2fr 2fr 1fr; width: 100%; height: 64px; border-radius: var(--r-xs); overflow: hidden;">' +
            '<div style="background: var(--' + family.varBase + ');" title="main"></div>' +
            '<div style="background: var(--' + family.varBase + '-wash);" title="wash"></div>' +
            '<div style="background: var(--bg-1); display: flex; align-items: center; justify-content: center; font-family: var(--serif); font-style: italic; font-size: 22px; color: var(--' + family.fgVar + ');" title="fg">Aa</div>' +
          '</div>' +
        '</div>' +
        '<div class="card-foot">' +
          '<span style="font-family: var(--mono); font-size: 9.5px;">main · wash · fg</span>' +
          (family.anchored
            ? '<span style="float: right; font-family: var(--mono); font-size: 9px; color: var(--fg-faint);">hue ' + family.hue + '°</span>'
            : '') +
        '</div>' +
      '</div>'
    );
  }

  function renderStatus() {
    return (
      '<h3 style="margin-top: var(--s-7);">Status <em style="font-family:var(--mono);font-size:10px;color:var(--fg-faint);font-style:normal;letter-spacing:0.06em;margin-left:8px;">semantic anchors</em></h3>' +
      '<p class="lede" style="font-size: 14px; margin-bottom: var(--s-3); max-width: 720px;">Four colors fixed by universal meaning: red, green, yellow, blue. They never move with the brand.</p>' +
      '<div class="grid">' +
      STATUS_COLORS.map(s => tripletCard({
        varBase: '--' + s.id,
        fgVar: s.id,
        hue: s.hue,
        note: s.note,
        anchored: true,
      })).join('') +
      '</div>'
    );
  }

  function renderStepKinds() {
    return (
      '<h3 style="margin-top: var(--s-7);">Step kinds <em style="font-family:var(--mono);font-size:10px;color:var(--fg-faint);font-style:normal;letter-spacing:0.06em;margin-left:8px;">workflow position</em></h3>' +
      '<p class="lede" style="font-size: 14px; margin-bottom: var(--s-3); max-width: 720px;">Five hues, each ≥30° from its neighbors. Chosen for perceptual distinctness across normal vision and most forms of color-blindness.</p>' +
      '<div class="grid">' +
      STEP_KINDS.map(k => tripletCard({
        varBase: '--step-' + k.id,
        fgVar: 'step-' + k.id + '-fg',
        hue: k.hue,
        note: k.note,
      })).join('') +
      '</div>'
    );
  }

  function renderHueWheel() {
    const cx = 200, cy = 200;
    const r = 140;

    function pos(deg, radius) {
      const rad = deg * Math.PI / 180;
      return { x: cx + radius * Math.sin(rad), y: cy - radius * Math.cos(rad) };
    }

    // Ring arcs — 36 segments around the wheel showing the OKLCH hue spectrum
    let arcs = '';
    for (let i = 0; i < 72; i++) {
      const a1 = i * 5;
      const a2 = (i + 1) * 5;
      const ro = r + 22, ri = r + 8;
      const p1 = pos(a1, ro), p2 = pos(a2, ro);
      const p3 = pos(a2, ri), p4 = pos(a1, ri);
      arcs += '<path d="M' + p1.x + ',' + p1.y +
        ' A' + ro + ',' + ro + ' 0 0 1 ' + p2.x + ',' + p2.y +
        ' L' + p3.x + ',' + p3.y +
        ' A' + ri + ',' + ri + ' 0 0 0 ' + p4.x + ',' + p4.y +
        ' Z" fill="oklch(0.74 0.16 ' + ((a1 + a2) / 2) + ')" opacity="0.55"/>';
    }

    // 30° tick marks + degree labels
    let ticks = '';
    for (let d = 0; d < 360; d += 30) {
      const p1 = pos(d, r + 4), p2 = pos(d, r - 4);
      ticks += '<line x1="' + p1.x + '" y1="' + p1.y + '" x2="' + p2.x + '" y2="' + p2.y +
        '" stroke="var(--line-strong)" stroke-width="0.8"/>';
      const lp = pos(d, r - 22);
      ticks += '<text x="' + lp.x + '" y="' + (lp.y + 3) + '" font-family="var(--mono)" font-size="9" fill="var(--fg-faint)" text-anchor="middle">' + d + '°</text>';
    }

    // Color markers
    const markers = ALL_HUES.map(c => {
      const m = pos(c.hue, r);
      const lp = pos(c.hue, r + 50);
      const anchor = m.x > cx + 5 ? 'start' : m.x < cx - 5 ? 'end' : 'middle';
      const dx = anchor === 'start' ? 4 : anchor === 'end' ? -4 : 0;
      const isAccent = c.id === 'accent';
      const labelColor = isAccent ? 'var(--accent)' : (c.anchor ? 'var(--fg-mute)' : 'var(--fg-mute)');
      const lineColor = isAccent ? 'var(--accent)' : 'var(--line-strong)';
      const indicator = c.anchor ? ' ⚓' : '';
      return (
        '<line x1="' + m.x + '" y1="' + m.y + '" x2="' + lp.x + '" y2="' + lp.y +
          '" stroke="' + lineColor + '" stroke-width="' + (isAccent ? '1.5' : '0.5') +
          '" stroke-dasharray="' + (isAccent ? '0' : '1 2') + '"/>' +
        '<circle cx="' + m.x + '" cy="' + m.y + '" r="' + (isAccent ? 10 : 7) +
          '" fill="var(--bg)" stroke="' + (isAccent ? 'var(--accent)' : 'var(--line-strong)') +
          '" stroke-width="' + (isAccent ? '1.5' : '1') + '"/>' +
        '<circle cx="' + m.x + '" cy="' + m.y + '" r="' + (isAccent ? 6 : 5) +
          '" fill="oklch(' + c.l + ' ' + c.c + ' ' + c.hue + ')"/>' +
        '<text x="' + (lp.x + dx) + '" y="' + (lp.y + 2) +
          '" font-family="var(--mono)" font-size="10" font-weight="' + (isAccent ? '600' : '400') +
          '" fill="' + labelColor + '" text-anchor="' + anchor + '">' + c.label + indicator + '</text>' +
        '<text x="' + (lp.x + dx) + '" y="' + (lp.y + 14) +
          '" font-family="var(--mono)" font-size="9" fill="var(--fg-faint)" text-anchor="' + anchor + '">' +
          c.hue + '°</text>'
      );
    }).join('');

    // Candidate marker (moves with sliders; defaults to accent's 0.74 / 0.18 / 40°)
    const cand = pos(40, r);
    const candMarker =
      '<g id="candidateMarker">' +
        '<line id="candLine" x1="' + cx + '" y1="' + cy + '" x2="' + cand.x + '" y2="' + cand.y +
          '" stroke="var(--fg)" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.5"/>' +
        '<circle id="candRing" cx="' + cand.x + '" cy="' + cand.y + '" r="14" fill="none" stroke="var(--fg)" stroke-width="1.5" stroke-dasharray="3 2"/>' +
        '<circle id="candDot" cx="' + cand.x + '" cy="' + cand.y + '" r="7" fill="oklch(0.74 0.18 40)"/>' +
      '</g>';

    // One labelled slider row for an OKLCH channel
    function chanRow(id, name, min, max, step, val, read) {
      return (
        '<div style="margin-bottom: 12px;">' +
          '<div style="display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 5px;">' +
            '<span style="font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--fg-faint);">' + name + '</span>' +
            '<span id="' + id + 'Read" style="font-family: var(--mono); font-size: 12px; color: var(--fg); font-weight: 500;">' + read + '</span>' +
          '</div>' +
          '<input type="range" id="' + id + 'Slider" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '" style="width: 100%; accent-color: var(--accent);">' +
        '</div>'
      );
    }

    // Distance readout rows (everything except accent)
    const distances = ALL_HUES.filter(c => c.id !== 'accent').map(c => {
      const initD = Math.abs(40 - c.hue);
      const dDeg = Math.min(initD, 360 - initD);
      const isStep = c.kind === 'step';
      return (
        '<div class="hue-dist" id="dist-' + c.id +
        '" style="display: grid; grid-template-columns: 18px 70px 1fr 50px; gap: 8px; align-items: center; padding: 5px 8px; border-radius: var(--r-xs); font-family: var(--mono); font-size: 11px; color: var(--fg-mute); transition: all var(--t-fast) var(--ease);">' +
          '<span style="width: 10px; height: 10px; border-radius: 50%; background: oklch(' + c.l + ' ' + c.c + ' ' + c.hue + ');"></span>' +
          '<span>' + c.label + (c.anchor ? ' <span style="color: var(--fg-faint);">⚓</span>' : '') + '</span>' +
          '<span style="font-size: 9px; color: var(--fg-faint);">' + (isStep ? 'step' : 'status') + ' · ' + c.hue + '°</span>' +
          '<span class="d" style="text-align: right; font-weight: 500;">' + Math.round(dDeg) + '°</span>' +
        '</div>'
      );
    }).join('');

    return (
      '<h3 style="margin-top: var(--s-7);">Hue relationships</h3>' +
      '<p class="lede" style="font-size: 14px; margin-bottom: var(--s-3); max-width: 720px;">The eleven hues plotted on an OKLCH wheel. <span style="font-family:var(--mono);font-size:11px;color:var(--fg-mute);">⚓ anchored</span> colors are fixed by universal meaning; step kinds are spread for perceptual distance.</p>' +
      '<div class="card" style="padding: var(--s-4);">' +
        '<div style="display: grid; grid-template-columns: minmax(380px, 1fr) 280px; gap: var(--s-5); align-items: start;">' +
          '<div style="display: flex; justify-content: center;">' +
            '<svg id="hueWheel" viewBox="0 0 400 400" style="width: 100%; max-width: 420px;">' +
              arcs +
              '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="0.5" stroke-dasharray="2 3"/>' +
              ticks +
              markers +
              candMarker +
              '<text x="' + cx + '" y="' + (cy - 6) + '" font-family="var(--serif)" font-style="italic" font-size="13" fill="var(--fg)" text-anchor="middle">OKLCH</text>' +
              '<text x="' + cx + '" y="' + (cy + 8) + '" font-family="var(--mono)" font-size="9" fill="var(--fg-faint)" text-anchor="middle">hue wheel · 0° → 360°</text>' +
            '</svg>' +
          '</div>' +

          '<div style="display: flex; flex-direction: column; gap: var(--s-4);">' +
            '<div>' +
              '<div style="font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--fg-faint); margin-bottom: 8px;">Move the accent →</div>' +
              '<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">' +
                '<div id="hueSample" style="width: 44px; height: 44px; border-radius: 50%; background: oklch(0.74 0.18 40); border: 1px solid var(--line-strong); flex-shrink: 0; box-shadow: 0 0 12px var(--accent-glow);"></div>' +
                '<div style="font-family: var(--mono); font-size: 11px; color: var(--fg-mute);">' +
                  '<div style="font-size: 9px; color: var(--fg-faint); letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 3px;">candidate</div>' +
                  '<div style="color: var(--fg); font-weight: 500; font-size: 12px;">oklch(<span id="lVal">0.74</span> <span id="cVal">0.180</span> <span id="hueValDeg">40</span>)</div>' +
                '</div>' +
              '</div>' +
              chanRow('l', 'Lightness', 0, 1, 0.01, 0.74, '0.74') +
              chanRow('c', 'Chroma', 0, 0.37, 0.005, 0.18, '0.180') +
              chanRow('hue', 'Hue · °', 0, 360, 1, 40, '40°') +
            '</div>' +

            '<div style="border-top: 1px solid var(--line); padding-top: var(--s-3);">' +
              '<div style="font-family: var(--mono); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--fg-faint); margin-bottom: 8px;">Distance to siblings</div>' +
              distances +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="card-foot" style="margin-top: var(--s-4);">' +
          '<b>Anchored colors</b> are fixed by universal meaning — red = err, green = ok, yellow = warn, blue = info, orange = brand. <b>Step kinds</b> are spread for distance. <span class="rule">Drag the L · C · H sliders to test a new accent. Rows turn red when the candidate lands within 30° of a step kind — those collisions create perceptual ambiguity.</span>' +
        '</div>' +
      '</div>'
    );
  }

  function renderLCMatrix() {
    const rows = [
      { v: 'accent',       fg: 'accent',         note: 'brand'  },
      { v: 'ok',           fg: 'ok',             note: 'status' },
      { v: 'warn',         fg: 'warn',           note: 'status' },
      { v: 'err',          fg: 'err',            note: 'status' },
      { v: 'info',         fg: 'info',           note: 'status' },
      { v: 'step-execute', fg: 'step-execute-fg', note: 'step'   },
      { v: 'step-eval',    fg: 'step-eval-fg',    note: 'step'   },
      { v: 'step-route',   fg: 'step-route-fg',   note: 'step'   },
      { v: 'step-human',   fg: 'step-human-fg',   note: 'step'   },
      { v: 'step-wait',    fg: 'step-wait-fg',    note: 'step'   },
    ];
    return (
      '<h3 style="margin-top: var(--s-7);">Variation system <em style="font-family:var(--mono);font-size:10px;color:var(--fg-faint);font-style:normal;letter-spacing:0.06em;margin-left:8px;">l × c → main · wash · fg</em></h3>' +
      '<p class="lede" style="font-size: 14px; margin-bottom: var(--s-3); max-width: 720px;">Each hue produces three siblings by moving along the lightness and chroma axes. Same recipe applied to every color — never pick three colors; pick one, derive the family.</p>' +
      '<div class="card">' +
        '<div class="card-canvas" style="padding: var(--s-4); display: grid; grid-template-columns: 130px repeat(3, 1fr); gap: 10px; align-items: stretch;">' +
          '<div></div>' +
          '<div style="text-align: center;"><div style="font-family: var(--mono); font-size: 10px; color: var(--fg-mute); letter-spacing: 0.1em; text-transform: uppercase;">main</div><div style="font-family: var(--mono); font-size: 9px; color: var(--fg-faint); margin-top: 2px;">l 0.72–0.82 · c 0.13–0.18</div></div>' +
          '<div style="text-align: center;"><div style="font-family: var(--mono); font-size: 10px; color: var(--fg-mute); letter-spacing: 0.1em; text-transform: uppercase;">wash</div><div style="font-family: var(--mono); font-size: 9px; color: var(--fg-faint); margin-top: 2px;">l 0.30 · c 0.10</div></div>' +
          '<div style="text-align: center;"><div style="font-family: var(--mono); font-size: 10px; color: var(--fg-mute); letter-spacing: 0.1em; text-transform: uppercase;">fg</div><div style="font-family: var(--mono); font-size: 9px; color: var(--fg-faint); margin-top: 2px;">l 0.82–0.88 · c 0.12–0.16</div></div>' +

          rows.map(row =>
            '<div style="font-family: var(--mono); font-size: 11px; color: var(--fg-mute); align-self: center; text-align: right; padding-right: 4px;">--' + row.v + '<div style="font-size: 9px; color: var(--fg-faint); margin-top: 2px;">' + row.note + '</div></div>' +
            '<div style="height: 44px; background: var(--' + row.v + '); border-radius: var(--r-xs); border: 1px solid var(--line);"></div>' +
            '<div style="height: 44px; background: var(--' + row.v + '-wash); border-radius: var(--r-xs); border: 1px solid var(--line);"></div>' +
            '<div style="height: 44px; background: var(--bg-1); border-radius: var(--r-xs); border: 1px solid var(--line); display: flex; align-items: center; justify-content: center; font-family: var(--serif); font-style: italic; font-size: 22px; color: var(--' + row.fg + ');">Aa</div>'
          ).join('') +
        '</div>' +
        '<div class="card-foot"><b>main</b> for borders, glyphs, accents. <b>wash</b> for safe background tints (low lightness, low chroma — won\u2019t fight text). <b>fg</b> for text on washed backgrounds (high lightness — reads cleanly).</div>' +
      '</div>'
    );
  }

  function renderRelationships() {
    return (
      '<h3 style="margin-top: var(--s-7);">What changes when you change the primary?</h3>' +
      '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-5); align-items: start; max-width: 1000px;">' +
        '<div class="prose" style="font-family: var(--sans); font-size: 13.5px; line-height: 1.7; color: var(--fg-soft);">' +
          '<p style="font-family: var(--serif); font-size: 17px; font-style: italic; color: var(--fg); margin-bottom: 14px; line-height: 1.4;">The short answer: only the accent moves. The wheel above is mostly anchored.</p>' +

          '<p style="margin-bottom: 12px;"><b style="color: var(--fg); font-weight: 500;">Status colors are universal anchors.</b> Red means failure. Green means success. Yellow means caution. Blue means reference. These don\u2019t rotate with the brand — moving them would break meaning that doesn\u2019t belong to us.</p>' +

          '<p style="margin-bottom: 12px;"><b style="color: var(--fg); font-weight: 500;">Step kinds are spread for distinctness.</b> Each kind sits at a hue chosen to be visually distinct from every other kind <em>and</em> from the accent. They could rotate together if the brand demanded it, but the <em>relative</em> distances (≥30° between any two) must be preserved.</p>' +
        '</div>' +
        '<div class="prose" style="font-family: var(--sans); font-size: 13.5px; line-height: 1.7; color: var(--fg-soft);">' +
          '<p style="margin-bottom: 12px;"><b style="color: var(--fg); font-weight: 500;">The accent is the only free variable.</b> Move it where you like — but a new accent must stay clear of every other hue. The slider above lets you test: anything within 30° of a step kind triggers a collision warning.</p>' +

          '<p style="margin-bottom: 12px;"><b style="color: var(--fg); font-weight: 500;">Lightness and chroma are deterministic.</b> Once you pick a hue, the main / wash / fg variants follow from fixed l/c offsets. You never pick three colors; you pick one and let the system produce the family.</p>' +

          '<p style="font-family: var(--serif); font-size: 14.5px; font-style: italic; color: var(--accent); padding: 12px 14px; background: var(--accent-wash); border: 1px solid color-mix(in oklch, var(--accent) 30%, transparent); border-left: 3px solid var(--accent); border-radius: var(--r-md); margin-top: 14px;">In Hearth, you do not pick a palette. You pick a hue. The rest is system.</p>' +
        '</div>' +
      '</div>'
    );
  }

  function renderColorSystem() {
    return renderSurfaces() + renderAccent() + renderStatus() +
      renderStepKinds() + renderHueWheel() + renderLCMatrix() + renderRelationships();
  }

  // Spacing scale + vertical rhythm (margins/padding on text)
  function renderSpacing() {
    const scale = [
      { t: 's-1', px: 4 }, { t: 's-2', px: 8 }, { t: 's-3', px: 12 },
      { t: 's-4', px: 16 }, { t: 's-5', px: 20 }, { t: 's-6', px: 24 },
      { t: 's-7', px: 28 }, { t: 's-8', px: 32 }, { t: 's-10', px: 40 },
      { t: 's-12', px: 48 }, { t: 's-16', px: 64 },
    ];
    const bars = scale.map(s =>
      '<div style="display: grid; grid-template-columns: 70px 1fr 46px; gap: 12px; align-items: center; padding: 4px 0;">' +
        '<span style="font-family: var(--mono); font-size: 10.5px; color: var(--fg-mute);">--' + s.t + '</span>' +
        '<div style="height: 14px; width: ' + s.px + 'px; background: var(--accent-wash); border-left: 2px solid var(--accent); border-radius: 0 var(--r-xs) var(--r-xs) 0;"></div>' +
        '<span style="font-family: var(--mono); font-size: 10px; color: var(--fg-faint); text-align: right;">' + s.px + 'px</span>' +
      '</div>'
    ).join('');

    // A labelled margin band between two text blocks
    function band(px, label) {
      return (
        '<div style="position: relative; height: ' + px + 'px; background: repeating-linear-gradient(-45deg, transparent, transparent 3px, color-mix(in oklch, var(--accent) 14%, transparent) 3px, color-mix(in oklch, var(--accent) 14%, transparent) 4px); border-top: 1px dashed color-mix(in oklch, var(--accent) 45%, transparent); border-bottom: 1px dashed color-mix(in oklch, var(--accent) 45%, transparent);">' +
          '<span style="position: absolute; right: 4px; top: 50%; transform: translateY(-50%); font-family: var(--mono); font-size: 9px; color: var(--accent); background: var(--bg); padding: 0 5px; white-space: nowrap;">' + label + '</span>' +
        '</div>'
      );
    }

    // Rows in the rhythm spec table
    const specRows = [
      { el: 'h2 / display',  m: 'margin: 6px 0 8px',              note: 'tight to lede' },
      { el: 'h3 / subhead',  m: 'margin: 24px 0 12px',           note: '--s-6 top · --s-3 bottom' },
      { el: '.lede',         m: 'margin-bottom: 20px',           note: '--s-5' },
      { el: 'p / body',      m: 'margin-bottom: 12px',           note: '--s-3 · between paragraphs' },
      { el: 'callout / prose', m: 'padding: 12px 14px',          note: '--s-3 · --s-4 inset' },
    ].map(r =>
      '<div style="display: grid; grid-template-columns: 130px 1fr; gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line);">' +
        '<span style="font-family: var(--mono); font-size: 10.5px; color: var(--fg);">' + r.el + '</span>' +
        '<span style="font-family: var(--mono); font-size: 10.5px; color: var(--fg-mute);">' + r.m +
          ' <span style="color: var(--fg-faint);">· ' + r.note + '</span></span>' +
      '</div>'
    ).join('');

    return (
      '<h3>Spacing &amp; rhythm <em style="font-family:var(--mono);font-size:10px;color:var(--fg-faint);font-style:normal;letter-spacing:0.06em;margin-left:8px;">the 4px base scale</em></h3>' +
      '<p class="lede" style="font-size: 14px; margin-bottom: var(--s-3); max-width: 720px;">Every gap, pad, and margin is a token off a 4px base. Text rhythm is fixed — paragraphs and headings carry the margins below so vertical spacing never gets eyeballed.</p>' +
      '<div class="grid two">' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-name">Spacing scale <em>· --s-*</em></div></div>' +
          '<div class="card-canvas col start" style="padding: var(--s-4); gap: 0;">' + bars + '</div>' +
          '<div class="card-foot"><b>Base 4px.</b> Steps run 4 → 28 by fours, then skip (32 → 40 → 48 → 64). <span class="rule">No raw pixel values in components — only tokens.</span></div>' +
        '</div>' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-name">Text rhythm <em>· measured margins</em></div></div>' +
          '<div class="card-canvas col start" style="padding: var(--s-4); gap: 0; align-items: stretch;">' +
            '<div class="t-h1" style="line-height: 1.15;">Workflow pipelines</div>' +
            band(12, 'h3 margin-bottom · 12px · --s-3') +
            '<div class="t-body" style="color: var(--fg-mute);">A lede sets up the section in one warm sentence.</div>' +
            band(20, 'lede margin-bottom · 20px · --s-5') +
            '<div class="t-body">First paragraph of running body copy at the 13px base size.</div>' +
            band(12, 'p margin-bottom · 12px · --s-3') +
            '<div class="t-body">Second paragraph — the gap between the two is fixed at --s-3.</div>' +
          '</div>' +
          '<div class="card-foot" style="font-family: var(--mono);">' + specRows + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // ── 1 · FOUNDATIONS ────────────────────────────────────────────
  function foundations() {
    let html = sectHeader('01', 'foundations', 'Foundations.',
      'Type, color, and motion. Every component below composes from these three sources, and breaks no rule of them.');

    // Type ramp
    html += '<h3>Type ramp</h3>';
    html += '<div style="border-top: 1px solid var(--line);">';
    [
      { sample: '<span class="t-display">A single vocabulary.</span>', meta: 'Display', detail: 'Newsreader italic · 38–48px · -0.02em' },
      { sample: '<span class="t-h1">Emit chat runner <em style="color:var(--accent);">activity events</em></span>', meta: 'H1 / detail title', detail: 'Newsreader italic · 19–22px · -0.015em' },
      { sample: '<span class="t-h2">Workflow Pipelines</span>', meta: 'H2 / surface title', detail: 'Geist · 15px · 500 weight' },
      { sample: '<span class="t-body">Suspend execution until all fanned-out child runs reach a terminal state.</span>', meta: 'Body', detail: 'Geist · 13px · 1.55 line-height' },
      { sample: '<span class="t-meta">2h 57m · 97 attempts · 67M tokens</span>', meta: 'Meta', detail: 'JetBrains Mono · 10–11px' },
      { sample: '<span class="t-label">step kind</span>', meta: 'Label', detail: 'JetBrains Mono uppercase · 10px · 0.16em tracking' },
    ].forEach(r => {
      html += '<div class="type-row"><div class="meta"><b>' + r.meta + '</b>' + r.detail + '</div><div>' + r.sample + '</div></div>';
    });
    html += '</div>';

    // Spacing & rhythm
    html += renderSpacing();

    // Color system
    html += renderColorSystem();

    html += '<div class="ember-callout"><em>Ember rule.</em> The accent (Hearthfire ember) is reserved for one thing: <em>now</em>. Running tasks, the live segment of a workflow, the selected row, fresh-in-flight runtime values. Nothing else takes the ember — not titles, not selections of inactive things, not warnings, not links.</div>';

    html += '</section>';
    return html;
  }

  // ── 2 · CHIP PRIMITIVES ────────────────────────────────────────
  function primitives() {
    let html = sectHeader('02', 'primitives', 'Chip primitives.',
      'Three small pieces of metal that name everything. RunChip says what work is doing. IdChip is how IDs travel. KindChip names a step\u2019s position in a workflow.');

    html += '<div class="grid wide">';

    // RunChip card
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">RunChip <em>· runtime state</em></div></div>' +
      '<div class="card-desc">One chip per row, ever. Carries state class + optional runtime suffix. Hidden entirely for terminal/null states — completed and cancelled rows show no chip.</div>' +
      '<div class="card-canvas">' +
        runChip('running', 'Running', '2m') +
        runChip('waiting', 'Waiting', '7h 36m') +
        runChip('queued', 'Queued') +
        runChip('completed', 'Completed') +
        runChip('failed', 'Failed') +
      '</div>' +
      '<div class="card-foot"><b>Variants:</b> running · waiting · queued · completed · failed · cancelled · stopped. <b>Sizes:</b> default, .sm.<br><span class="rule">Rule — for terminal states (completed/cancelled/stopped) and null (never run), render nothing.</span></div>' +
    '</div>';

    // IdChip
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">IdChip <em>· copyable identity</em></div></div>' +
      '<div class="card-desc">Every ID is one of these — never bare text. Hover reveals copy glyph, click flashes green ✓. Works on task IDs, run IDs, event IDs, trace IDs.</div>' +
      '<div class="card-canvas">' +
        idChip('40628099') +
        idChip('c794b783') +
        idChip('t1.codex') +
        idChip('wait.c794') +
      '</div>' +
      '<div class="card-foot"><b>States:</b> rest · hover · pressed · copied. <span class="rule">Rule — every ID in the system is rendered as IdChip. No exceptions.</span></div>' +
    '</div>';

    // KindChip
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">KindChip <em>· workflow position</em></div></div>' +
      '<div class="card-desc">Names the kind of step. Always paired with its hue swatch so the palette is reinforced everywhere the chip appears.</div>' +
      '<div class="card-canvas">' +
        kindChip('execute') + kindChip('eval') + kindChip('route') + kindChip('human') + kindChip('wait') +
      '</div>' +
      '<div class="card-foot"><b>Used in:</b> step-detail header · field rows · step transition events.</div>' +
    '</div>';

    html += '</div></section>';
    return html;
  }

  // ── 3 · HIERARCHY ──────────────────────────────────────────────
  function hierarchy() {
    let html = sectHeader('03', 'hierarchy', 'Hierarchy.',
      'Epic, ticket, task. Three glyphs, three type weights, one indent system. Read at a glance — you never have to count levels.');

    html += '<div class="grid two">';

    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">Glyphs &amp; level type ramp</div></div>' +
      '<div class="card-canvas col start">' +
        '<div class="mini-tr l0"><span class="c-glyph l0">◈</span><span class="ttl">Vertebrae Web App</span><span class="right"><span class="c-run-chip running"><span class="spinner"></span>Running</span><span class="when">Apr 25</span></span></div>' +
        '<div class="mini-tr l1"><span class="c-glyph l1">◇</span><span class="ttl">Explore backend chat sessions</span><span class="right"><span class="c-run-chip running sm"><span class="spinner"></span>Running</span><span class="when">18d</span></span></div>' +
        '<div class="mini-tr l2"><span class="c-glyph l2">·</span><span class="ttl">Hydrate chat runner state and resume pending work</span><span class="right"><span class="c-run-chip running sm"><span class="spinner"></span>2m</span><span class="when">2m</span></span></div>' +
      '</div>' +
      '<div class="card-foot"><b>Glyph map:</b> ◈ epic · ◇ ticket · · task. <b>Type:</b> epic in serif italic, ticket sans 500, task sans 400. <span class="rule">Rule — the glyph and type ramp together carry hierarchy. Indentation is reinforcement, not the signal.</span></div>' +
    '</div>';

    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">IndentGuide</div></div>' +
      '<div class="card-desc">A 1px dashed vertical inside the row\u2019s left margin. Renders only when the row is indented under an open parent — never on roots, never on collapsed branches.</div>' +
      '<div class="card-canvas col start" style="font-family:var(--mono); font-size: 11px; color: var(--fg-faint);">' +
        '<div style="position:relative; padding: 4px 0 4px 28px;"><span style="position:absolute; left:8px; top:0; bottom:0; border-right:1px dashed var(--line);"></span><span style="color: var(--fg-mute);">◇ ticket</span></div>' +
        '<div style="position:relative; padding: 4px 0 4px 50px;"><span style="position:absolute; left:8px; top:0; bottom:0; border-right:1px dashed var(--line);"></span><span style="position:absolute; left:30px; top:0; bottom:0; border-right:1px dashed var(--line);"></span><span style="color: var(--fg-soft);">· task</span></div>' +
        '<div style="position:relative; padding: 4px 0 4px 50px;"><span style="position:absolute; left:8px; top:0; bottom:0; border-right:1px dashed var(--line);"></span><span style="position:absolute; left:30px; top:0; bottom:0; border-right:1px dashed var(--line);"></span><span style="color: var(--fg-soft);">· task</span></div>' +
      '</div>' +
      '<div class="card-foot"><b>Usage:</b> tasks list, traces task rail. <span class="rule">Rule — guides on the rendered tree, never as visual filler on flat lists.</span></div>' +
    '</div>';

    html += '</div></section>';
    return html;
  }

  // ── 4 · COMPOUND STATE ─────────────────────────────────────────
  function compound() {
    let html = sectHeader('04', 'compound', 'Compound state.',
      'Where kind meets state. Each segment is hued by stepKind and brightened by runState. The system\u2019s most expressive widget.');

    html += '<div class="grid wide">';

    // Pipeline strip with kind × state matrix
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">Pipeline strip</div></div>' +
      '<div class="card-desc">Compact horizontal segments. Kind = hue, state = opacity + glow. Five kinds × four states = the entire vocabulary in a 4px-tall ribbon.</div>' +
      '<div class="card-canvas col start" style="padding: var(--s-4);">';

    // The matrix
    html += '<table style="border-collapse: collapse; font-family: var(--mono); font-size: 10px; color: var(--fg-faint); width: 100%;">' +
      '<tr><td></td>' +
      '<td style="padding: 4px 8px; text-align: center;">completed</td>' +
      '<td style="padding: 4px 8px; text-align: center;">running</td>' +
      '<td style="padding: 4px 8px; text-align: center;">waiting</td>' +
      '<td style="padding: 4px 8px; text-align: center;">queued</td>' +
      '</tr>';
    ['execute', 'eval', 'route', 'human', 'wait'].forEach(k => {
      html += '<tr>' +
        '<td style="padding: 6px 8px; text-align: right; color: var(--fg-mute);">' + k + '</td>';
      ['completed', 'running', 'waiting', 'queued'].forEach(s => {
        html += '<td style="padding: 6px 8px;"><span class="c-pipeline" style="width: 60px; height: 6px;"><span class="seg kind-' + k + ' s-' + s + '"></span></span></td>';
      });
      html += '</tr>';
    });
    html += '</table>';

    // Realistic example
    html += '<div style="margin-top: var(--s-4); width: 100%;">' +
      '<div style="font-family: var(--mono); font-size: 10px; color: var(--fg-faint); margin-bottom: 6px;">Example — running ticket\u2019s workflow:</div>' +
      '<span class="c-pipeline" style="width: 200px; height: 8px;">' +
        '<span class="seg kind-execute s-completed"></span>' +
        '<span class="seg kind-execute s-completed"></span>' +
        '<span class="seg kind-execute s-completed"></span>' +
        '<span class="seg kind-execute s-running"></span>' +
        '<span class="seg kind-eval s-queued"></span>' +
        '<span class="seg kind-human s-queued"></span>' +
        '<span class="seg kind-wait s-queued"></span>' +
      '</span>' +
    '</div>';

    html += '</div>' +
      '<div class="card-foot"><b>Used in:</b> task row meta · board card · workflow rail item · flight strip. <span class="rule">Rule — never label segments with text. The hue + state IS the legend, repeated everywhere.</span></div>' +
    '</div>';

    // StepDot
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">StepDot</div></div>' +
      '<div class="card-desc">Pellet form of the pipeline. Used in hero status dots, minimaps, child summaries. Same kind/state encoding; circle silhouette.</div>' +
      '<div class="card-canvas">' +
        '<span class="c-dot done"></span>' +
        '<span class="c-dot done"></span>' +
        '<span class="c-dot running"></span>' +
        '<span class="c-dot waiting"></span>' +
        '<span class="c-dot queued"></span>' +
        '<span class="c-dot queued"></span>' +
      '</div>' +
      '<div class="card-foot"><b>Variants:</b> done (✓), running (ember pulse), waiting (warn), queued (outline). <span class="rule">No connecting lines between dots — the graph engine can loop.</span></div>' +
    '</div>';

    // Breakdown
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">StateBreakdown</div></div>' +
      '<div class="card-desc">The replacement for linear &ldquo;X of Y&rdquo;. Workflows are graphs that can loop; counting forward progress is dishonest. Show per-state counts instead.</div>' +
      '<div class="card-canvas">' +
        '<span class="c-breakdown">' +
          '<span class="b-done">\u2713 4</span>' +
          '<span class="sep">·</span>' +
          '<span class="b-run">\u25b6 1</span>' +
          '<span class="sep">·</span>' +
          '<span class="b-wait">\u23f8 1</span>' +
          '<span class="sep">·</span>' +
          '<span class="b-q">\u25cb 2</span>' +
        '</span>' +
      '</div>' +
      '<div class="card-foot"><b>Glyphs:</b> ✓ done · ▶ running · ⏸ waiting · ○ queued. <span class="rule">Rule — only render counts &gt; 0. Hide states with zero items.</span></div>' +
    '</div>';

    html += '</div></section>';
    return html;
  }

  // ── 5 · LAYOUT DIAGRAMS ────────────────────────────────────────
  function layouts() {
    let html = sectHeader('05', 'layouts', 'Page layouts.',
      'How the components compose into each surface. Annotated wireframes for the four canonical views — each one a shell + a unique center + an optional inspector.');

    // Tasks layout
    html += '<h3>Tasks <em style="font-family:var(--mono);font-size:11px;color:var(--fg-faint);font-style:normal;letter-spacing:0.04em;margin-left:10px;">tasks-v2.html</em></h3>';
    html += '<div class="diagram diag-tasks">' +
      '<div class="stub-top-2">TASKS</div>' +
      '<div class="frame">' +
        '<div class="region" style="grid-row:1/2;"><div class="reg-name">Side rail</div><div class="reg-comps">SideRail<br>(44px)</div></div>' +
        '<div class="region accent"><div class="reg-name">List column</div><div class="reg-comps">ScopeRow + SearchBar<br>TaskRow × N<br>(Epic ◈ / Ticket ◇ / Task ·)<br>IndentGuide</div></div>' +
        '<div class="region"><div class="reg-name">Detail panel</div><div class="reg-comps">DetailHeader · IdChip · Actions<br>HeroStatus (state-colored)<br>Accordion: Children<br>Accordion: Spec / Deps / Code / Details<br>TracesLink (footer)</div></div>' +
      '</div>' +
      '<div class="annot"><b>Selection model:</b> click a row → detail panel updates. ↑/↓ navigate · ←/→ collapse-or-jump · Esc deselects. <b>The detail panel is always-on</b> — Tasks is a "what do I focus on" surface, so the focused item gets permanent real estate.</div>' +
    '</div>';

    // Board layout
    html += '<h3 style="margin-top: var(--s-6);">Board <em style="font-family:var(--mono);font-size:11px;color:var(--fg-faint);font-style:normal;letter-spacing:0.04em;margin-left:10px;">board-v2.html</em></h3>';
    html += '<div class="diagram diag-board">' +
      '<div class="stub-top-2">BOARD</div>' +
      '<div class="frame">' +
        '<div class="region"><div class="reg-name">Side rail</div><div class="reg-comps">SideRail</div></div>' +
        '<div class="region"><div class="reg-name">Queued</div><div class="reg-comps">BoardCard × N<br>+ NewTaskStub</div></div>' +
        '<div class="region accent"><div class="reg-name">Running</div><div class="reg-comps">BoardCard.running<br>(ember left)</div></div>' +
        '<div class="region"><div class="reg-name">Waiting</div><div class="reg-comps">BoardCard.waiting</div></div>' +
        '<div class="region"><div class="reg-name">Done</div><div class="reg-comps">BoardCard.done<br>(no chip, dimmed)</div></div>' +
      '</div>' +
      '<div class="annot"><b>Columns = runState</b>, not workflow stage. <b>Card kind</b> shows on top edge (stepKind hue). Click card → navigate to <code style="font-family:var(--mono);font-size:10px;color:var(--accent);">tasks-v2.html#&lt;id&gt;</code>. View tabs (List ⇄ Board) live in the header.</div>' +
    '</div>';

    // Design layout
    html += '<h3 style="margin-top: var(--s-6);">Design <em style="font-family:var(--mono);font-size:11px;color:var(--fg-faint);font-style:normal;letter-spacing:0.04em;margin-left:10px;">design-v2.html</em></h3>';
    html += '<div class="diagram diag-design">' +
      '<div class="stub-top-2">DESIGN · workflows</div>' +
      '<div class="frame">' +
        '<div class="region reg-side"><div class="reg-name">Side rail</div></div>' +
        '<div class="region reg-list"><div class="reg-name">Workflow catalog</div><div class="reg-comps">SearchBar<br>WorkflowRailItem × 10<br>(name · shape · meta)</div></div>' +
        '<div class="region accent reg-canvas"><div class="reg-name">Graph canvas</div><div class="reg-comps">StepNode × N (positioned)<br>GraphEdge + .live<br>OverlayToggle (header)<br>ZoomWidget + Minimap (corners)</div></div>' +
        '<div class="region reg-insp"><div class="reg-name">Inspector <em style="color:var(--fg-faint);">(collapsed by default)</em></div><div class="reg-comps">Step title<br>KindChip<br>Contract prose<br>Currently running<br>Recent completions<br>Stats fields</div></div>' +
        '<div class="region reg-strip"><div class="reg-name">Active runs strip</div><div class="reg-comps">RunCard × N (waiting/running) · "at step N · kind"</div></div>' +
      '</div>' +
      '<div class="annot"><b>The graph IS the workflow definition; the runtime is an overlay.</b> The inspector slides in only when a node is clicked. Bottom strip shows live runs through this workflow — click a run to anchor its current step in the graph.</div>' +
    '</div>';

    // Traces layout
    html += '<h3 style="margin-top: var(--s-6);">Traces <em style="font-family:var(--mono);font-size:11px;color:var(--fg-faint);font-style:normal;letter-spacing:0.04em;margin-left:10px;">traces-v2.html</em></h3>';
    html += '<div class="diagram diag-traces">' +
      '<div class="stub-top-2">TRACES</div>' +
      '<div class="frame">' +
        '<div class="region reg-side"><div class="reg-name">Side rail</div></div>' +
        '<div class="region reg-tasks"><div class="reg-name">Tasks tree</div><div class="reg-comps">TaskRow × N · IdChip</div></div>' +
        '<div class="region reg-runs"><div class="reg-name">Runs</div><div class="reg-comps">RunCard × N<br>(waiting · failed · completed)</div></div>' +
        '<div class="region accent reg-center"><div class="reg-name">Trace center</div><div class="reg-comps">DetailHeader · IdChip · HeroStatus<br>FlightStrip (Steps · Tools · Turns)<br>ScopeRow + SearchBar (filters)<br>EventStream — Step / Agent / Tool / Wait / Error</div></div>' +
      '</div>' +
      '<div class="annot"><b>Rail does double duty:</b> top half = task tree (which task am I tracing), bottom half = runs of that task (which attempt). The selected run gets the ember edge. <b>FlightStrip</b> sits above the events — same time axis, drives auto-scroll viewport.</div>' +
    '</div>';

    html += '</section>';
    return html;
  }

  // ── 6 · SHELL ──────────────────────────────────────────────────
  function shell() {
    let html = sectHeader('06', 'shell', 'Shell.',
      'The frame around every page. Same topbar, same rail, same connection indicator, on every surface.');

    html += '<div class="grid">';

    // Topbar
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">TopBar</div></div>' +
      '<div class="card-desc">Brand mark with ember dot · breadcrumb (project › page) · live activity readout · ⌘K hint.</div>' +
      '<div class="card-canvas" style="padding: 0; min-height: 0;">' +
        '<div class="mini-topbar" style="width: 100%;">' +
          '<span style="font-family:var(--serif);font-style:italic;font-size:14px;color:var(--fg);">Vertebrae</span>' +
          '<span style="width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent-glow);"></span>' +
          '<span style="color:var(--fg-faint);">sacrum <span style="color:var(--fg-ghost);">›</span> <span style="font-family:var(--serif);font-style:italic;color:var(--fg);font-size:14px;">Tasks</span></span>' +
          '<span style="margin-left:auto;display:flex;align-items:center;gap:10px;">' +
            '<span style="display:inline-flex;align-items:center;gap:5px;color:var(--accent);"><span style="width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent-glow);"></span>3 running</span>' +
            '<span style="color:var(--fg-mute);"><b style="color:var(--fg);">100</b> tasks</span>' +
            '<span style="color:var(--fg-faint);">⌘K</span>' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Height:</b> 38px fixed. <b>Activity:</b> live count on accent + total in neutral. <span class="rule">Rule — the single-line activity readout never adds metrics beyond running count + total.</span></div>' +
    '</div>';

    // Side rail
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">SideRail</div></div>' +
      '<div class="card-desc">44px vertical rail. Logo, divider, icon items, active state with accent stripe + glow, vertical "connected" sys label at bottom.</div>' +
      '<div class="card-canvas tall" style="padding: var(--s-3); justify-content: flex-start;">' +
        '<div class="mini-side" style="height: 200px;">' +
          '<div style="width:24px;height:24px;background:var(--accent);color:var(--bg);border-radius:var(--r-md);display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-style:italic;font-size:14px;box-shadow:0 0 8px var(--accent-glow);">s</div>' +
          '<hr style="width: 18px; border: none; border-top: 1px solid var(--line);">' +
          '<div style="width:24px;height:24px;border-radius:var(--r-sm);display:flex;align-items:center;justify-content:center;color:var(--fg-mute);"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="11" rx="1"/></svg></div>' +
          '<div style="position:relative;width:24px;height:24px;background:var(--accent-wash);color:var(--accent);border-radius:var(--r-sm);display:flex;align-items:center;justify-content:center;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg><span style="position:absolute;left:-5px;top:3px;bottom:3px;width:2px;background:var(--accent);box-shadow:0 0 6px var(--accent-glow);border-radius:0 2px 2px 0;"></span></div>' +
          '<div style="width:24px;height:24px;color:var(--fg-mute);display:flex;align-items:center;justify-content:center;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="5" cy="6" r="3"/><circle cx="19" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="m7 8 4 8M17 8l-4 8"/></svg></div>' +
          '<div style="width:24px;height:24px;color:var(--fg-mute);display:flex;align-items:center;justify-content:center;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3-9 4 18 3-9h4"/></svg></div>' +
          '<div style="margin-top:auto;display:flex;flex-direction:column;align-items:center;gap:4px;font-family:var(--mono);font-size:8px;color:var(--fg-faint);text-transform:uppercase;letter-spacing:0.1em;writing-mode:vertical-rl;transform:rotate(180deg);"><span style="width:5px;height:5px;border-radius:50%;background:var(--ok);writing-mode:horizontal-tb;transform:rotate(180deg);box-shadow:0 0 4px color-mix(in oklch, var(--ok) 60%, transparent);"></span>connected</div>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Item states:</b> rest · hover · active. <b>Connection:</b> ok green dot + vertical "connected" mono label at bottom. <span class="rule">Rule — never expand the rail. If something needs naming, use tooltips. The rail stays at 44px.</span></div>' +
    '</div>';

    // AppFrame
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">AppFrame</div></div>' +
      '<div class="card-desc">The shell composer: TopBar over horizontal flex of SideRail + center column + optional right Inspector.</div>' +
      '<div class="card-canvas" style="padding: 0; min-height: 0;">' +
        '<div style="width: 100%; display: flex; flex-direction: column; gap: 4px; padding: var(--s-3);">' +
          '<div style="background:var(--bg-2);height:18px;border-radius:2px;border:1px solid var(--line);display:flex;align-items:center;padding:0 8px;font-family:var(--mono);font-size:8px;color:var(--fg-faint);letter-spacing:0.16em;text-transform:uppercase;">TopBar</div>' +
          '<div style="display:flex;gap:4px;height:120px;">' +
            '<div style="width:24px;background:var(--bg-2);border:1px solid var(--line);border-radius:2px;display:flex;align-items:flex-start;justify-content:center;padding-top:4px;font-family:var(--mono);font-size:8px;color:var(--fg-faint);writing-mode:vertical-rl;letter-spacing:0.12em;text-transform:uppercase;">Rail</div>' +
            '<div style="flex:1;background:var(--bg-2);border:1px solid var(--line);border-radius:2px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:9px;color:var(--fg-mute);">Center column</div>' +
            '<div style="width:80px;background:color-mix(in oklch, var(--accent-wash) 30%, var(--bg-2));border:1px dashed color-mix(in oklch, var(--accent) 30%, var(--line));border-radius:2px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:8px;color:var(--accent);letter-spacing:0.1em;text-transform:uppercase;">Inspector</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Inspector states:</b> open (360px) · closed (0px, slide-out). <span class="rule">Rule — Inspector is collapsible on Design / Traces, always-on for Tasks (because Tasks is single-focus by definition).</span></div>' +
    '</div>';

    html += '</div></section>';
    return html;
  }

  // ── 7 · ROWS & CARDS ───────────────────────────────────────────
  function rows() {
    let html = sectHeader('07', 'rows', 'Rows &amp; cards.',
      'Where the vocabulary lives day-to-day. Same chips, same hues, applied across list rows, board cards, run cards, and workflow rail items.');

    html += '<div class="grid wide">';

    // TaskRow
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">TaskRow</div></div>' +
      '<div class="card-desc">The tasks-v2 list row. Three level styles, shared grammar: chev · glyph · title · priority + meta · right (chip · id · when).</div>' +
      '<div class="card-canvas col start" style="padding: var(--s-3);">' +
        '<div class="mini-tr l0" style="width:100%;"><span class="c-glyph l0">◈</span><span class="ttl">Vertebrae Web App</span><span class="right"><span class="c-run-chip running"><span class="spinner"></span>Running</span>' + idChip('2b064abb') + '<span class="when">Apr 25</span></span></div>' +
        '<div class="mini-tr l1 sel" style="width:100%;"><span class="c-glyph l1">◇</span><span class="ttl">Emit chat runner activity events</span><span class="right"><span class="c-run-chip waiting"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Waiting · 7h 36m</span>' + idChip('40628099') + '<span class="when">11h</span></span></div>' +
        '<div class="mini-tr l2" style="width:100%;"><span class="c-glyph l2">·</span><span class="ttl">Hydrate chat runner state and resume pending work</span><span class="right"><span class="c-run-chip running sm"><span class="spinner"></span>2m</span>' + idChip('c794b783') + '<span class="when">2m</span></span></div>' +
        '<div class="mini-tr l2" style="width:100%;"><span class="c-glyph l2">·</span><span class="ttl">Define client-safe chat runner activity event builders</span><span class="right">' + idChip('80e1a7b6') + '<span class="when">7h</span></span></div>' +
      '</div>' +
      '<div class="card-foot"><b>Selected row:</b> accent-wash bg + 2px ember left stripe. <b>Completed:</b> no chip, title in fg-mute. <span class="rule">Rule — never two chips per row.</span></div>' +
    '</div>';

    // BoardCard
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">BoardCard</div></div>' +
      '<div class="card-desc">Vertical card for the kanban surface. Top-edge hue = stepKind. Running variant gets the ember left edge + accent-wash gradient.</div>' +
      '<div class="card-canvas" style="padding: var(--s-3); align-items: stretch;">' +
        '<div style="display:flex;gap:10px;width:100%;">' +
          '<div class="mini-bc kind-execute" style="flex:1;">' +
            '<div style="display:flex;align-items:center;gap:6px;"><span class="c-glyph l1">◇</span><span class="ttl">Stream live chat responses</span></div>' +
            '<span class="step-tag kind-execute">step · execute</span>' +
            '<div class="foot"><span class="c-run-chip queued sm">Queued</span><span>0ac78100</span><span class="when">13d</span></div>' +
          '</div>' +
          '<div class="mini-bc kind-wait running" style="flex:1;">' +
            '<div style="display:flex;align-items:center;gap:6px;"><span class="c-glyph l1" style="color:var(--accent);">◇</span><span class="ttl">Emit chat runner activity events</span></div>' +
            '<span class="step-tag">step · wait</span>' +
            '<div class="foot"><span class="c-run-chip waiting sm">Waiting · 7h 36m</span><span style="color:var(--accent);">40628099</span><span class="when" style="margin-left:auto;">11h</span></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Variants:</b> queued (plain) · running (ember) · waiting (plain) · done (dimmed, no chip). <span class="rule">Rule — top edge hue = stepKind. Ember = runState. Never conflate the two.</span></div>' +
    '</div>';

    // RunCard
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">RunCard</div></div>' +
      '<div class="card-desc">Compact card representing a single attempt of a task. Used in traces rail and in design-v2 "active runs" strip.</div>' +
      '<div class="card-canvas">' +
        '<div class="runcard-mini sel">' +
          '<div class="head">' + runChip('waiting', 'Waiting', '7h 36m') + idChip('43abee9d') + '</div>' +
          '<div class="when">started 01:13 AM</div>' +
        '</div>' +
        '<div class="runcard-mini">' +
          '<div class="head">' + runChip('failed', 'Failed') + idChip('6b2f5482') + '</div>' +
          '<div class="when">started 01:05 AM <span style="color:var(--err);">· tool timeout</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Selected run</b> gets ember left edge. <b>Failed</b> shows reason inline after timestamp.</div>' +
    '</div>';

    // WorkflowRailItem
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">WorkflowRailItem</div></div>' +
      '<div class="card-desc">A workflow entry in the design-v2 left rail. Title in serif italic, shape mini-strip below, live + 24h stats in mono.</div>' +
      '<div class="card-canvas">' +
        '<div class="wfri-mini sel">' +
          '<div class="name">Chat Runner Lifecycle</div>' +
          '<div class="shape">' +
            '<span class="seg kind-execute"></span><span class="seg kind-eval"></span><span class="seg kind-route"></span><span class="seg kind-execute"></span><span class="seg kind-wait"></span><span class="seg kind-execute"></span><span class="seg terminal"></span>' +
          '</div>' +
          '<div class="meta"><span class="live"><span class="pulse"></span>1 running</span><span class="sep">·</span><span>7 steps</span><span class="sep">·</span><span>10 / 24h</span></div>' +
        '</div>' +
        '<div class="wfri-mini">' +
          '<div class="name">Authoring · Verifier Gate</div>' +
          '<div class="shape">' +
            '<span class="seg kind-execute"></span><span class="seg kind-eval"></span><span class="seg kind-human"></span><span class="seg kind-execute"></span><span class="seg terminal"></span>' +
          '</div>' +
          '<div class="meta"><span>5 steps</span><span class="sep">·</span><span>14 / 24h</span><span class="sep">·</span><span>avg 1m 38s</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Shape strip</b> compactly summarizes step kinds in order. <b>Live count</b> only appears when &gt; 0.</div>' +
    '</div>';

    html += '</div></section>';
    return html;
  }

  // ── 8 · DETAIL PANEL ───────────────────────────────────────────
  function detail() {
    let html = sectHeader('08', 'detail', 'Detail panel.',
      'The composable focus surface. Header + hero status + accordion sections + footer actions. Used identically in Tasks (always-on) and Traces (header only).');

    html += '<div class="grid">';

    // DetailHeader
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">DetailHeader</div></div>' +
      '<div class="card-desc">Title (serif italic, with optional accent emphasis on a noun phrase) · IdChip · breadcrumb (parent ticket / level) · action ctrls.</div>' +
      '<div class="card-canvas col start" style="padding: var(--s-3);">' +
        '<div style="font-family:var(--serif);font-size:19px;font-style:italic;color:var(--fg);letter-spacing:-0.01em;line-height:1.2;">Emit chat runner activity events and replace single-shot <em style="color:var(--accent);">live chat runner</em> lifecycle</div>' +
        '<div style="font-family:var(--mono);font-size:11px;color:var(--fg-faint);display:flex;align-items:center;gap:8px;margin-top:10px;">' + idChip('40628099') + '<span>·</span><span>ticket</span><span>·</span><span>under <em style="color:var(--fg-mute);font-family:var(--serif);font-style:italic;">Vertebrae Web App</em></span></div>' +
      '</div>' +
      '<div class="card-foot"><b>Selective emphasis</b> on a noun via &lt;em&gt; in accent. <span class="rule">Use sparingly — one emphasized phrase per title.</span></div>' +
    '</div>';

    // HeroStatus
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">HeroStatus</div></div>' +
      '<div class="card-desc">The "what is happening right now" pill. State-colored left border, run state label, runtime, step pointer.</div>' +
      '<div class="card-canvas col start" style="padding: var(--s-3);">' +
        '<div class="hero-mini" style="width:100%;">' +
          '<span style="color:var(--warn);"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>' +
          '<span class="state">Waiting · for children</span>' +
          '<span class="sep">·</span>' +
          '<span class="runtime">7h 36m running</span>' +
          '<span class="sep">·</span>' +
          '<span>at step <em style="font-family:var(--serif);font-style:italic;color:var(--step-wait-fg);">5 · wait</em></span>' +
        '</div>' +
        '<div class="hero-mini" style="width:100%;border-left-color: var(--step-execute);">' +
          '<span style="color:var(--accent);"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></span>' +
          '<span class="state" style="color:var(--accent);">Running</span>' +
          '<span class="sep">·</span>' +
          '<span class="runtime">2m</span>' +
          '<span class="sep">·</span>' +
          '<span>at step <em style="font-family:var(--serif);font-style:italic;color:var(--step-execute-fg);">4 · execute</em></span>' +
        '</div>' +
        '<div class="hero-mini" style="width:100%;border-left-color: var(--ok);">' +
          '<span style="color:var(--ok);"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span>' +
          '<span class="state" style="color:var(--ok);">Completed</span>' +
          '<span class="sep">·</span>' +
          '<span style="color:var(--fg-mute);">completed 11h ago</span>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>State-driven layout:</b> waiting shows runtime + step, completed shows finish time, running shows live runtime. Edge color = stepKind.</div>' +
    '</div>';

    // Accordion + FieldRow
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">Accordion + FieldRow</div></div>' +
      '<div class="card-desc">Collapsible section pattern for the detail body. Headers carry the section name + count. Inside, FieldRow for compact attribute lists.</div>' +
      '<div class="card-canvas col start" style="padding: var(--s-3);">' +
        '<div class="acc-mini" style="width:100%;"><div class="acc-hd"><span class="chev">▾</span><span class="name accent">Children</span><span class="count">6</span></div></div>' +
        '<div class="acc-mini" style="width:100%;"><div class="acc-hd"><span class="chev">▾</span><span class="name">Details</span></div>' +
          '<div class="acc-bd">' +
            '<div class="field"><span class="k">Step kind</span><span class="v" style="font-family:var(--serif);font-style:italic;color:var(--step-wait-fg);">wait</span></div>' +
            '<div class="field"><span class="k">Priority</span><span class="v" style="color:var(--err);">High ↑</span></div>' +
            '<div class="field"><span class="k">Updated</span><span class="v">11h ago</span></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Accordion default state:</b> Children open · Spec/Deps/Code/Details collapsed. <b>Counts</b> only when meaningful.</div>' +
    '</div>';

    // RecentItem
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">RecentItem</div></div>' +
      '<div class="card-desc">A single line in a "recent runs" or "children" list. Dot + name + time on the right.</div>' +
      '<div class="card-canvas col start" style="padding: var(--s-3);">' +
        '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;width:100%;">' +
          '<span style="width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 4px var(--accent-glow);"></span>' +
          '<span style="font-family:var(--sans);font-size:12px;color:var(--fg);flex:1;">Emit chat runner activity events</span>' +
          '<span style="font-family:var(--mono);font-size:10px;color:var(--accent);">7h 36m</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;width:100%;">' +
          '<span style="width:7px;height:7px;border-radius:50%;background:var(--ok);"></span>' +
          '<span style="font-family:var(--sans);font-size:12px;color:var(--fg-soft);flex:1;">Stream live chat — turn 184</span>' +
          '<span style="font-family:var(--mono);font-size:10px;color:var(--fg-faint);">2m</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;width:100%;">' +
          '<span style="width:7px;height:7px;border-radius:50%;background:var(--ok);"></span>' +
          '<span style="font-family:var(--sans);font-size:12px;color:var(--fg-soft);flex:1;">Drive authoring intents — verifier pass</span>' +
          '<span style="font-family:var(--mono);font-size:10px;color:var(--fg-faint);">11m</span>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Dot variants:</b> done · running (ember pulse) · waiting (warn). Used in Children sections, step inspector, traces tasks rail.</div>' +
    '</div>';

    html += '</div></section>';
    return html;
  }

  document.getElementById('catalogBody').innerHTML =
    foundations() + primitives() + hierarchy() + compound() +
    layouts() + shell() + rows() + detail() +
    '<div id="catalogContinue"></div>';

  // Continuation in components-v2-content-2.js
})();
