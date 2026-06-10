/* ──────────────────────────────────────────────────────────────────
   Hearth · Components v2 — Catalog content (part 2)
   Sections 9–13: graph, traces, filters, switches, motion.
   ────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  function idChip(id) {
    return '<span class="c-id-chip" data-id="' + id + '"><span class="id-text">' + id + '</span>' +
      '<svg class="copy-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
      '<svg class="ok-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' +
      '</span>';
  }
  function sectHeader(num, name, title, lede) {
    return '<section class="sect" id="' + name + '">' +
      '<div class="sect-num">§ ' + num + ' · ' + name + '</div>' +
      '<h2>' + title + '</h2>' +
      '<p class="lede">' + lede + '</p>';
  }

  // ── 9 · WORKFLOW GRAPH ─────────────────────────────────────────
  function graph() {
    let html = sectHeader('09', 'graph', 'Workflow graph.',
      'The design-v2 surface. Step nodes hued by kind, edges plain or live (animated accent), and a minimap that mirrors the same palette.');

    html += '<div class="grid">';

    // StepNode
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">StepNode</div></div>' +
      '<div class="card-desc">A workflow definition\u2019s vertex. 2px top edge in kind hue · num badge · kind label · title · optional description · optional runs-row when active.</div>' +
      '<div class="card-canvas">' +
        '<div class="mini-node kind-execute">' +
          '<div class="row"><span class="num">1</span><span class="kind">execute</span></div>' +
          '<div class="ttl">accept_user_turn</div>' +
        '</div>' +
        '<div class="mini-node kind-wait active">' +
          '<div class="row"><span class="num">5</span><span class="kind">wait</span></div>' +
          '<div class="ttl">wait_for_children</div>' +
          '<div class="runs"><span class="pulse"></span>1 running · 7h 36m</div>' +
        '</div>' +
      '</div>' +
      '<div class="card-canvas">' +
        '<div class="mini-node kind-eval">' +
          '<div class="row"><span class="num">2</span><span class="kind">eval</span></div>' +
          '<div class="ttl">classify_intent</div>' +
        '</div>' +
        '<div class="mini-node kind-route">' +
          '<div class="row"><span class="num">3</span><span class="kind">route</span></div>' +
          '<div class="ttl">route_to_tools</div>' +
        '</div>' +
        '<div class="mini-node kind-human">' +
          '<div class="row"><span class="num">6</span><span class="kind">human</span></div>' +
          '<div class="ttl">request_review</div>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Active state</b> gets the ember treatment (3px left stripe, accent border, glow, runs-row footer). <span class="rule">Rule — never colour the node body by kind. Hue lives on the top edge so nodes scan as a kind-sequence.</span></div>' +
    '</div>';

    // GraphEdge
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">GraphEdge <em>· + GraphMarkers</em></div></div>' +
      '<div class="card-desc">One routed SVG path, styled entirely from the <code>--edge-*</code> tokens via the <code>.gedge</code> classes — never inline attributes. Three kinds × three trace states, plus the legacy animated <b>live</b> variant. Drop one <code>&lt;GraphMarkers/&gt;</code> in the same canvas for the arrowheads.</div>' +
      '<div class="card-canvas" style="min-height: 176px;">' +
        '<svg width="100%" height="164" viewBox="0 0 320 164">' +
          '<defs>' +
            '<marker id="ge-n" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--line-strong)"/></marker>' +
            '<marker id="ge-a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"/></marker>' +
            '<marker id="ge-r" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--step-route)"/></marker>' +
          '</defs>' +
          '<path d="M20,28 H150" stroke="var(--line-strong)" stroke-width="1.5" stroke-opacity="0.85" fill="none" marker-end="url(#ge-n)"/>' +
          '<text x="166" y="32" font-family="var(--mono)" font-size="10" fill="var(--fg-mute)">step · within a workflow</text>' +
          '<path d="M20,64 H150" stroke="var(--line-strong)" stroke-width="1.5" stroke-opacity="0.85" stroke-dasharray="5 4" fill="none" marker-end="url(#ge-n)"/>' +
          '<text x="166" y="68" font-family="var(--mono)" font-size="10" fill="var(--fg-mute)">handoff · between workflows</text>' +
          '<path d="M20,100 H150" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4" fill="none" marker-end="url(#ge-a)" style="filter:drop-shadow(0 0 5px var(--accent-glow));"/>' +
          '<text x="166" y="104" font-family="var(--mono)" font-size="10" fill="var(--accent)">handoff · lit (on a trace)</text>' +
          '<path d="M20,136 H150" stroke="var(--step-route)" stroke-width="1.5" stroke-opacity="0.72" stroke-dasharray="3 3" fill="none" marker-end="url(#ge-r)"/>' +
          '<text x="166" y="140" font-family="var(--mono)" font-size="10" fill="var(--step-route-fg)">loop · back-edge</text>' +
        '</svg>' +
      '</div>' +
      '<div class="card-foot"><b>kind</b> step / handoff / loop · <b>state</b> base / lit / dim · <b>solid</b> forces a handoff undashed (the high-level map). Handoffs accent on a live trace; step links only recede. <span class="rule">Rule — endpoints anchor to the workflow bounding box, never its interior (wf-elk.js).</span></div>' +
    '</div>';

    // RunPellet
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">RunPellet</div></div>' +
      '<div class="card-desc">Tiny rounded chip that appears inside an active StepNode, naming the live tasks currently at that step.</div>' +
      '<div class="card-canvas">' +
        '<span class="run-pellet-mini"><span class="dot"></span>c794b783</span>' +
        '<span class="run-pellet-mini"><span class="dot"></span>40628099</span>' +
      '</div>' +
      '<div class="card-foot"><b>Click</b> to focus that task in tasks-v2.</div>' +
    '</div>';

    // Minimap
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">Minimap</div></div>' +
      '<div class="card-desc">Faithful reduction of the main canvas. Nodes preserve their kind palette; active step pulses; current viewport drawn as a dashed accent box.</div>' +
      '<div class="card-canvas">' +
        '<div style="width:240px;height:90px;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-sm);padding:8px;">' +
          '<svg viewBox="0 0 200 60" preserveAspectRatio="none" style="width:100%;height:100%;">' +
            '<g stroke="var(--line-strong)" stroke-width="1" fill="none">' +
              '<path d="M14,30 H38"/><path d="M48,30 H62"/><path d="M72,30 H86"/>' +
              '<path d="M96,30 L110,18"/><path d="M96,30 L110,30"/><path d="M96,30 L110,42"/>' +
              '<path d="M120,18 L134,30"/><path d="M120,30 H134"/><path d="M120,42 L134,30"/>' +
              '<path d="M144,30 H158"/><path d="M168,30 H182"/>' +
            '</g>' +
            '<rect x="4"  y="26" width="10" height="8" rx="1" fill="var(--step-execute)" opacity="0.7"/>' +
            '<rect x="38" y="26" width="10" height="8" rx="1" fill="var(--step-eval)"    opacity="0.7"/>' +
            '<rect x="62" y="26" width="10" height="8" rx="1" fill="var(--step-route)"   opacity="0.7"/>' +
            '<rect x="86" y="14" width="10" height="8" rx="1" fill="var(--step-execute)" opacity="0.5"/>' +
            '<rect x="86" y="26" width="10" height="8" rx="1" fill="var(--step-execute)" opacity="0.7"/>' +
            '<rect x="86" y="38" width="10" height="8" rx="1" fill="var(--step-execute)" opacity="0.5"/>' +
            '<rect x="110" y="26" width="10" height="8" rx="1" fill="var(--accent)" stroke="var(--accent)" stroke-width="0.5">' +
              '<animate attributeName="opacity" values="1;0.4;1" dur="1.6s" repeatCount="indefinite"/>' +
            '</rect>' +
            '<rect x="134" y="26" width="10" height="8" rx="1" fill="var(--step-execute)" opacity="0.7"/>' +
            '<rect x="158" y="26" width="10" height="8" rx="1" fill="var(--ok)" opacity="0.7"/>' +
            '<rect x="2" y="6" width="80" height="48" fill="none" stroke="var(--accent)" stroke-width="0.8" stroke-dasharray="3 2" opacity="0.6"/>' +
          '</svg>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Always-on</b> in bottom-right corner of design-v2 canvas.</div>' +
    '</div>';

    // ZoomWidget
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">ZoomWidget</div></div>' +
      '<div class="card-desc">Vertical +/-/fit button stack pinned to bottom-left of pannable canvases.</div>' +
      '<div class="card-canvas">' +
        '<div style="display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden;">' +
          '<button style="width:28px;height:28px;background:transparent;border:none;border-bottom:1px solid var(--line);color:var(--fg-mute);cursor:pointer;font-family:var(--mono);font-size:14px;">＋</button>' +
          '<button style="width:28px;height:28px;background:transparent;border:none;border-bottom:1px solid var(--line);color:var(--fg-mute);cursor:pointer;font-family:var(--mono);font-size:14px;">−</button>' +
          '<button style="width:28px;height:28px;background:transparent;border:none;color:var(--fg-mute);cursor:pointer;font-family:var(--mono);font-size:14px;">⊡</button>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Buttons:</b> zoom-in · zoom-out · fit-to-content. <span class="rule">Add the <code>floating</code> prop / <code>.floating</code> modifier to pin it to a canvas corner (Atlas + Graph).</span></div>' +
    '</div>';

    // graph-step (dense ELK vertex)
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">graph-step <em>· dense ELK vertex</em></div></div>' +
      '<div class="card-desc">The compact step box ELK positions inside the Graph topology. Distinct from StepNode (the roomier catalog vertex): kind reads as a 2px top rule + an inline tag, with a role footer. Reads the <code>.k-*</code> palette.</div>' +
      '<div class="card-canvas" style="gap:10px;">' +
        graphStepMini('1', 'inbox', 'entry', 'var(--accent)', 'var(--accent)', 'var(--accent-wash)') +
        graphStepMini('2', 'classify', 'eval', 'var(--step-eval)', 'var(--step-eval-fg)', 'var(--step-eval-wash)') +
      '</div>' +
      '<div class="card-foot"><b>Footer dot</b> turns ember when a run is live at the step. <span class="rule">Rule — kind colours the top rule + tag, never the body.</span></div>' +
    '</div>';

    // graph-wf (workflow container)
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">graph-wf <em>· + gw-status</em></div></div>' +
      '<div class="card-desc">The titled container ELK sizes around a workflow\u2019s step cluster: name, run-status badge, id · step-count meta, and a clamped description. States: active (live) · lit / dim (trace focus).</div>' +
      '<div class="card-canvas">' +
        '<div style="width:100%;max-width:430px;background:color-mix(in oklch,var(--bg-1) 90%,transparent);border:1px solid var(--line-strong);border-radius:var(--r-lg);box-shadow:var(--shadow-1);overflow:hidden;">' +
          '<div style="padding:12px 14px 10px;border-bottom:1px solid var(--line);background:color-mix(in oklch,var(--bg-1) 60%,transparent);">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<span style="font-family:var(--sans);font-size:14px;font-weight:600;letter-spacing:-0.01em;color:var(--fg);">Backlog</span>' +
              '<span style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;padding:1px 6px;font-family:var(--mono);font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:var(--step-execute-fg);border:1px solid color-mix(in oklch,var(--step-execute) 35%,transparent);background:var(--step-execute-wash);border-radius:var(--r-xs);">in progress</span>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-family:var(--mono);font-size:9px;color:var(--fg-faint);"><span style="color:var(--fg-ghost);">eb4e20fd</span><span style="color:var(--fg-ghost);">·</span><span>3 steps</span></div>' +
            '<div style="margin-top:6px;font-family:var(--sans);font-size:11px;line-height:1.4;color:var(--fg-mute);">Default intake for new tickets. Triage from the inbox, evaluate, and route to the right place.</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>gw-status</b> hues by phase: <em>active</em> (ok, pulsing) · <em>in progress</em> · <em>review</em> · <em>human</em> · <em>plan</em>.</div>' +
    '</div>';

    // value-stream card (Atlas) + StepStrip
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">value-stream card <em>· Atlas + StepStrip</em></div></div>' +
      '<div class="card-desc">One workflow as a card on the Atlas value-stream map: serif name, optional live ember, a StepStrip reduction of its step kinds, and a mono meta line. States: live · lit · dim.</div>' +
      '<div class="card-canvas">' +
        '<div style="width:230px;display:flex;flex-direction:column;gap:8px;padding:12px 13px;border:1px solid color-mix(in oklch,var(--accent) 40%,var(--line-strong));border-radius:var(--r-md);background-image:linear-gradient(150deg,var(--accent-wash),var(--bg-1) 60%);">' +
          '<div style="display:flex;align-items:flex-start;gap:8px;">' +
            '<span style="flex:1;font-family:var(--serif);font-style:italic;font-size:15px;line-height:1.2;color:var(--accent);">Backlog</span>' +
            '<span style="display:inline-flex;align-items:center;gap:4px;margin-top:2px;font-family:var(--mono);font-size:10px;color:var(--accent);"><span style="width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 5px var(--accent-glow);"></span>live</span>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">' +
            vsChip('entry', 'var(--accent)', 'var(--accent)', 'var(--accent-wash)') + vsArrow() +
            vsChip('eval', 'var(--step-eval)', 'var(--step-eval-fg)', 'var(--step-eval-wash)') + vsArrow() +
            vsChip('route', 'var(--step-route)', 'var(--step-route-fg)', 'var(--step-route-wash)') +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;color:var(--fg-faint);"><span>3 steps</span><span style="color:var(--fg-ghost);">·</span><span>12/24h</span><span style="color:var(--fg-ghost);">·</span><span>3m 12s</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>StepStrip</b> reduces the step kinds four ways: <em>ribbon</em> (proportion) · <em>pipeline</em> (ordered dots) · <em>grouped</em> (run-length, shown) · <em>tally</em> (counts).</div>' +
    '</div>';

    // KindLegend
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">KindLegend</div></div>' +
      '<div class="card-desc">Footer strip mapping kind swatches to labels (reads the <code>.k-*</code> palette), with a trailing hint. Anchors the bottom of both canvas pages.</div>' +
      '<div class="card-canvas">' +
        '<div style="display:flex;align-items:center;gap:16px;font-family:var(--mono);font-size:10px;color:var(--fg-faint);flex-wrap:wrap;">' +
          legendItem('entry', 'var(--accent)') + legendItem('execute', 'var(--step-execute)') +
          legendItem('eval', 'var(--step-eval)') + legendItem('route', 'var(--step-route)') +
          legendItem('wait', 'var(--step-wait)') + legendItem('human', 'var(--step-human)') +
          legendItem('done', 'var(--ok)') +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>One palette, everywhere</b> \u2014 the same <code>--step-*</code> hues drive StepNode, graph-step, StepStrip and these swatches.</div>' +
    '</div>';

    html += '</div></section>';
    return html;
  }

  // mini helpers for the graph cards
  function graphStepMini(num, name, kind, kc, kf, kw) {
    return '<div style="width:150px;box-sizing:border-box;display:flex;flex-direction:column;gap:5px;padding:8px 9px 6px;background:var(--bg-2);border:1px solid var(--line-strong);border-top:2px solid ' + kc + ';border-radius:var(--r-sm);">' +
      '<div style="display:flex;align-items:center;gap:5px;">' +
        '<span style="width:16px;height:16px;display:flex;align-items:center;justify-content:center;border-radius:var(--r-xs);background:color-mix(in oklch,' + kc + ' 22%,var(--bg));border:1px solid color-mix(in oklch,' + kc + ' 40%,transparent);font-family:var(--mono);font-size:9px;color:' + kf + ';">' + num + '</span>' +
        '<span style="flex:1;min-width:0;font-family:var(--mono);font-size:10px;font-weight:500;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + name + '</span>' +
        '<span style="padding:0 3px;font-family:var(--mono);font-size:8px;letter-spacing:0.08em;text-transform:uppercase;color:' + kf + ';background:color-mix(in oklch,' + kw + ' 40%,transparent);border:1px solid color-mix(in oklch,' + kc + ' 40%,transparent);border-radius:var(--r-xs);">' + kind + '</span>' +
      '</div>' +
      '<div style="height:1px;background:var(--line);"></div>' +
      '<div style="display:flex;align-items:center;gap:4px;font-family:var(--mono);font-size:8px;letter-spacing:0.1em;text-transform:uppercase;color:var(--fg-faint);"><span style="width:4px;height:4px;border-radius:50%;background:var(--fg-ghost);"></span>' + kind + '</div>' +
    '</div>';
  }
  function vsChip(label, kc, kf, kw) {
    return '<span style="display:inline-flex;align-items:center;padding:1px 6px;font-family:var(--mono);font-size:10px;color:' + kf + ';background:color-mix(in oklch,' + kw + ' 42%,transparent);border:1px solid color-mix(in oklch,' + kc + ' 40%,transparent);border-radius:var(--r-xs);">' + label + '</span>';
  }
  function vsArrow() { return '<span style="color:var(--fg-ghost);font-size:11px;">\u203a</span>'; }
  function legendItem(label, kc) {
    return '<span style="display:inline-flex;align-items:center;gap:6px;"><span style="width:9px;height:9px;border-radius:var(--r-xs);background:' + kc + ';"></span>' + label + '</span>';
  }

  // ── 10 · TRACES ────────────────────────────────────────────────
  function traces() {
    let html = sectHeader('10', 'traces', 'Traces.',
      'The chronicle of one run. FlightStrip pins time horizontally; the event stream plays it back row by row.');

    html += '<div class="grid full">';

    // FlightStrip
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">FlightStrip <em>· three lanes</em></div></div>' +
      '<div class="card-desc">Steps lane uses StepKind hues as horizontal bars. Tools and Turns lanes use pips. Time ruler at bottom. Viewport range marks the visible window of the event stream; play-head marks the newest event.</div>' +
      '<div class="card-canvas" style="min-height: 130px;">' +
        '<div class="mini-flight" style="width:100%;">' +
          '<div class="lane l1"><span class="lane-label">Steps</span></div>' +
          '<div class="lane l2"><span class="lane-label">Tools</span></div>' +
          '<div class="lane l3"><span class="lane-label">Turns</span></div>' +

          '<div class="mk kind-execute" style="left:2%; width:8%; top:4px;"></div>' +
          '<div class="mk kind-eval"    style="left:11%; width:6%; top:4px;"></div>' +
          '<div class="mk kind-route"   style="left:18%; width:4%; top:4px;"></div>' +
          '<div class="mk kind-execute" style="left:23%; width:14%; top:4px;"></div>' +
          '<div class="mk kind-wait live" style="left:38%; width:56%; top:4px;"></div>' +

          '<div class="pip tool"  style="left:4%; top:33px;"></div>' +
          '<div class="pip tool"  style="left:7%; top:33px;"></div>' +
          '<div class="pip tool"  style="left:14%; top:33px;"></div>' +
          '<div class="pip tool"  style="left:24%; top:33px;"></div>' +
          '<div class="pip tool"  style="left:30%; top:33px;"></div>' +
          '<div class="pip error" style="left:33%; top:33px;"></div>' +
          '<div class="pip tool"  style="left:36%; top:33px;"></div>' +

          '<div class="pip agent" style="left:3%; top:55px;"></div>' +
          '<div class="pip agent" style="left:6%; top:55px;"></div>' +
          '<div class="pip agent" style="left:11%; top:55px;"></div>' +
          '<div class="pip agent" style="left:16%; top:55px;"></div>' +
          '<div class="pip agent" style="left:23%; top:55px;"></div>' +
          '<div class="pip agent" style="left:28%; top:55px;"></div>' +

          '<div class="vp" style="left:5%; width:8%;"></div>' +
          '<div class="play" style="left:94%;"></div>' +

          '<div class="ruler">' +
            '<div class="tick">+0s</div><div class="tick">+18m</div><div class="tick">+36m</div><div class="tick">+54m</div>' +
            '<div class="tick">+1h12m</div><div class="tick">+1h30m</div><div class="tick">+1h48m</div><div class="tick">+2h06m</div>' +
            '<div class="tick">+2h24m</div><div class="tick">+2h42m</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Lanes:</b> Steps (kind-hued bars) · Tools (execute-tinted pips, error pips in red) · Turns (neutral pips). <b>Live segment</b> on Steps gets the ember outline + glow. <span class="rule">Rule — never label markers with text. Hovering surfaces detail; the chart is for scan, not read.</span></div>' +
    '</div>';

    // Event kinds
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">EventCard <em>· five kinds</em></div></div>' +
      '<div class="card-desc">The event stream is heterogeneous. Each kind has its own card shape so the eye lands on the right thing first.</div>' +
      '<div class="card-canvas col start" style="padding: var(--s-3); gap: 4px;">' +

        // Step transition
        '<div class="mini-ev step kind-execute" style="width:100%;">' +
          '<div class="when">01:13:42.483<span class="rel">+0s</span></div>' +
          '<div class="body"><span class="arr">→</span><span class="to">accept_user_turn</span><span class="tag">execute</span></div>' +
        '</div>' +

        // Agent turn
        '<div class="mini-ev agent" style="width:100%;">' +
          '<div class="when">01:13:54.033<span class="rel">+11.5s</span></div>' +
          '<div class="body">' +
            '<div class="speaker">Agent · Codex</div>' +
            '<div class="prose">I\u2019ll ground this in the live tracker record and nearby Sacrum code paths first, then create only direct child tasks in dependency order.</div>' +
          '</div>' +
        '</div>' +

        // Tool call
        '<div class="mini-ev tool" style="width:100%;">' +
          '<div class="when">01:14:01.110<span class="rel">+18.6s</span></div>' +
          '<div class="body"><span class="sd"></span><span class="prompt">$</span>rg <span style="color:var(--fg-mute);">-n</span> <em>"chat runner activity|hydrate_session"</em><span class="dur">142ms</span></div>' +
        '</div>' +

        // Tool error
        '<div class="mini-ev tool err" style="width:100%;">' +
          '<div class="when">01:22:48.300<span class="rel">+9m 06s</span></div>' +
          '<div class="body"><span class="sd"></span><span class="prompt">$</span>mix test <em>chat_session_runner_test.exs</em><span class="dur">2.4s</span></div>' +
        '</div>' +

        // Error
        '<div class="mini-ev error" style="width:100%;">' +
          '<div class="when">01:22:48.150<span class="rel">+9m 06s</span></div>' +
          '<div class="body" style="display:flex;flex-direction:column;align-items:flex-start;gap:4px;"><b style="color:var(--err);">tool · run_tests failed (exit 1)</b><span style="font-family:var(--mono);font-size:11px;color:var(--fg-mute);">2 of 41 tests failed. Retrying with isolated runner.</span></div>' +
        '</div>' +

        // Step transition into wait
        '<div class="mini-ev step kind-wait" style="width:100%;">' +
          '<div class="when">01:50:14.847<span class="rel">+36m 32s</span></div>' +
          '<div class="body"><span style="color:var(--fg-mute);">tool fan-out</span><span class="arr">→</span><span class="to">wait_for_children</span><span class="tag">wait</span></div>' +
        '</div>' +

        // Wait
        '<div class="mini-ev wait" style="width:100%;">' +
          '<div class="when">01:50:15.012<span class="rel">+36m 32s</span></div>' +
          '<div class="body"><span>Waiting on 3 child tasks · 7h 36m</span><span class="flow"></span><span style="color:var(--accent);font-family:var(--mono);font-size:10px;">c794b783</span></div>' +
        '</div>' +

      '</div>' +
      '<div class="card-foot"><b>Card shapes by kind:</b> step (left-bordered pill) · agent (neutral left border + speaker + prose) · tool (compact code line) · wait (warn-tinted, animated bar) · error (red-bordered). <span class="rule">Rule — never put the kind name as a label. The visual treatment IS the label.</span></div>' +
    '</div>';

    html += '</div></section>';
    return html;
  }

  // ── 11 · FILTERS & SEARCH ──────────────────────────────────────
  function filters() {
    let html = sectHeader('11', 'filters', 'Filters &amp; search.',
      'Faceted, count-aware, keyboard-friendly. The same idiom across every list.');

    html += '<div class="grid">';

    // ScopeChip
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">ScopeChip</div></div>' +
      '<div class="card-desc">Single-select filter chip with count badge. Active state in accent (or err for error scopes). Separators group related facets.</div>' +
      '<div class="card-canvas col start" style="padding: var(--s-3); align-items: flex-start;">' +
        '<div style="display:flex;gap:2px;flex-wrap:wrap;align-items:center;">' +
          '<span class="scope-mini active">Active <span class="n">3</span></span>' +
          '<span class="scope-mini">Waiting <span class="n">14</span></span>' +
          '<span class="scope-mini">Blocked <span class="n">2</span></span>' +
          '<span class="scope-mini">Recent</span>' +
          '<span style="width:1px;height:14px;background:var(--line);margin:0 6px;"></span>' +
          '<span class="scope-mini">Backlog <span class="n">68</span></span>' +
          '<span class="scope-mini">Done <span class="n">19</span></span>' +
        '</div>' +
        '<div style="display:flex;gap:2px;flex-wrap:wrap;align-items:center;margin-top:10px;">' +
          '<span class="scope-mini">All <span class="n">52</span></span>' +
          '<span class="scope-mini">Steps <span class="n">5</span></span>' +
          '<span class="scope-mini">Tools <span class="n">31</span></span>' +
          '<span class="scope-mini">Turns <span class="n">14</span></span>' +
          '<span class="scope-mini">Waits <span class="n">1</span></span>' +
          '<span class="scope-mini err active">Errors <span class="n">1</span></span>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Used in:</b> tasks scope row · traces filter row. <b>Counts</b> always live, computed from current data.</div>' +
    '</div>';

    // SearchBar
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">SearchBar</div></div>' +
      '<div class="card-desc">bg-1 fill, magnifier icon, kbd hint on the right (<code style="font-family:var(--mono);font-size:10px;color:var(--accent);">/</code> for stream-search, <code style="font-family:var(--mono);font-size:10px;color:var(--accent);">⌘K</code> for global). Focus = accent border + glow.</div>' +
      '<div class="card-canvas">' +
        '<div class="search-mini">' +
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
          '<input placeholder="Search tasks by title, id, or tag…">' +
          '<span class="hint"><kbd>/</kbd></span>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Hint glyph</b> shows which key focuses it. <b>Behavior:</b> filters live as you type.</div>' +
    '</div>';

    // LevelSelect
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">LevelSelect</div></div>' +
      '<div class="card-desc">Secondary filter dropdown. Mono, minimal — never the primary filter. Used to flatten a hierarchy.</div>' +
      '<div class="card-canvas">' +
        '<select style="background:var(--bg-1);border:1px solid var(--line-strong);color:var(--fg-mute);padding:6px 10px;border-radius:var(--r-sm);font-family:var(--mono);font-size:11px;">' +
          '<option>All levels</option><option>Epics only</option><option>Tickets</option><option>Tasks</option>' +
        '</select>' +
      '</div>' +
      '<div class="card-foot"><b>Rule</b> — keep secondary filters as plain selects, not as chip rows. Chips reserve attention for facets the user changes often.</div>' +
    '</div>';

    html += '</div></section>';
    return html;
  }

  // ── 12 · TABS & SWITCHES ───────────────────────────────────────
  function switches() {
    let html = sectHeader('12', 'switches', 'Tabs &amp; switches.',
      'View-switching, overlay-toggling, and the tiny pill that says &ldquo;follow the head.&rdquo;');

    html += '<div class="grid">';

    // ViewTabs
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">ViewTabs</div></div>' +
      '<div class="card-desc">Segmented control for parallel views of the same data. Two-item is canonical (List ⇄ Board).</div>' +
      '<div class="card-canvas">' +
        '<div class="view-tabs-mini">' +
          '<a><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>List</a>' +
          '<a class="active"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="11" rx="1"/></svg>Board</a>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Sits in:</b> top toolbar of List/Board. <b>Sync:</b> selection survives across the switch.</div>' +
    '</div>';

    // OverlayToggle
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">OverlayToggle</div></div>' +
      '<div class="card-desc">Segmented control that modifies how a surface paints (not what it shows). Live state can carry a pulse dot.</div>' +
      '<div class="card-canvas">' +
        '<div class="ov-toggle-mini">' +
          '<button class="active"><span class="pulse"></span>Active runs</button>' +
          '<button>Recent</button>' +
          '<button>Off</button>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Used in:</b> design-v2 graph header. <b>Off</b> hides the live edges and active-step ember — useful for authoring the workflow itself.</div>' +
    '</div>';

    // SegControl
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">SegControl</div></div>' +
      '<div class="card-desc">Accent-on segmented switch for the canvas pages — the Map ⇄ Graph view switch and the Atlas step-grouping switch. Items can be links (navigational) or buttons (stateful); an optional mono caption caps the left edge.</div>' +
      '<div class="card-canvas" style="flex-direction:column;gap:10px;align-items:flex-start;">' +
        '<div style="display:inline-flex;border:1px solid var(--line-strong);border-radius:var(--r-md);overflow:hidden;background:var(--bg-1);">' +
          '<a style="display:flex;align-items:center;height:28px;padding:0 12px;border-right:1px solid var(--line);background:var(--accent-wash);color:var(--accent);font-family:var(--sans);font-size:12px;font-weight:500;">Map</a>' +
          '<a style="display:flex;align-items:center;height:28px;padding:0 12px;background:transparent;color:var(--fg-mute);font-family:var(--sans);font-size:12px;">Graph</a>' +
        '</div>' +
        '<div style="display:inline-flex;align-items:stretch;border:1px solid var(--line-strong);border-radius:var(--r-md);overflow:hidden;background:var(--bg-1);">' +
          '<span style="display:flex;align-items:center;padding:0 8px;border-right:1px solid var(--line);font-family:var(--mono);font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:var(--fg-faint);">Steps</span>' +
          '<button style="height:28px;padding:0 10px;border:none;border-right:1px solid var(--line);background:var(--accent-wash);color:var(--accent);font-family:var(--sans);font-size:12px;font-weight:500;cursor:pointer;">Grouped</button>' +
          '<button style="height:28px;padding:0 10px;border:none;border-right:1px solid var(--line);background:transparent;color:var(--fg-mute);font-family:var(--sans);font-size:12px;cursor:pointer;">Pipeline</button>' +
          '<button style="height:28px;padding:0 10px;border:none;background:transparent;color:var(--fg-mute);font-family:var(--sans);font-size:12px;cursor:pointer;">Ribbon</button>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Not ViewTabs</b> — same job, different skin: SegControl is sans + accent-active; ViewTabs is mono + bg-3-active. Use SegControl on the Atlas/Graph canvas, ViewTabs in list/board toolbars. <span class="rule">window.SegControl({ items, label }).</span></div>' +
    '</div>';

    // AutoScrollSwitch
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">AutoScrollSwitch</div></div>' +
      '<div class="card-desc">A tiny pill: when on, the surface follows the newest event. Knob turns ember when active.</div>' +
      '<div class="card-canvas">' +
        '<div class="auto-mini"><span class="sw"></span>Auto-scroll</div>' +
        '<div class="auto-mini off"><span class="sw"></span>Auto-scroll</div>' +
      '</div>' +
      '<div class="card-foot"><b>Active by default</b> on live runs. Toggling off pins the viewport.</div>' +
    '</div>';

    // KnobToggle
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">KnobToggle</div></div>' +
      '<div class="card-desc">Inline pill switch with a trailing mono label — the Atlas <em>Conditions</em> and Graph <em>Labels</em> toggles. Knob and label turn ember when on.</div>' +
      '<div class="card-canvas">' +
        '<div style="display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--accent);">' +
          '<span style="position:relative;width:30px;height:17px;background:var(--accent-wash);border:1px solid var(--accent-mute);border-radius:var(--r-full);box-shadow:0 0 8px var(--accent-glow);">' +
            '<span style="position:absolute;top:1px;left:1px;width:13px;height:13px;border-radius:50%;background:var(--accent);transform:translateX(13px);box-shadow:0 0 5px var(--accent-glow);"></span>' +
          '</span>Conditions</div>' +
        '<div style="display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--fg-mute);">' +
          '<span style="position:relative;width:30px;height:17px;background:var(--bg-4);border:1px solid var(--line-strong);border-radius:var(--r-full);">' +
            '<span style="position:absolute;top:1px;left:1px;width:13px;height:13px;border-radius:50%;background:var(--fg-faint);"></span>' +
          '</span>Labels</div>' +
      '</div>' +
      '<div class="card-foot"><b>Sibling of AutoScrollSwitch</b> — same knob, but reads as a persistent overlay toggle on the canvas rather than a follow-the-head pill. <span class="rule">window.KnobToggle({ on, onToggle, label }).</span></div>' +
    '</div>';

    // IconButton
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">IconButton</div></div>' +
      '<div class="card-desc">26–28px utility button for header actions. Outlined on hover, no fill by default.</div>' +
      '<div class="card-canvas">' +
        '<button class="icon-btn-mini" title="Detach"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>' +
        '<button class="icon-btn-mini" title="Run"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>' +
        '<button class="icon-btn-mini" title="More"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button>' +
        '<button class="icon-btn-mini" title="Close"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
      '</div>' +
      '<div class="card-foot"><b>Sizes:</b> 26px (compact, inside cards) · 28px (header). <span class="rule">No filled-button variant — the chip vocabulary handles emphasis.</span></div>' +
    '</div>';

    // Button (text)
    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">Button</div></div>' +
      '<div class="card-desc">Three text-button variants: primary (accent fill), ghost (transparent), small. Used for destination actions like &ldquo;New task&rdquo; or footer ⊙ Inspect.</div>' +
      '<div class="card-canvas">' +
        '<button class="btn">＋ New</button>' +
        '<button class="btn ghost">＋ Add task</button>' +
        '<button class="btn sm">⊙ Inspect</button>' +
      '</div>' +
      '<div class="card-foot"><b>Use sparingly</b> — most actions are IconButtons in header. Primary fills only for the one destination action per surface.</div>' +
    '</div>';

    html += '</div></section>';
    return html;
  }

  // ── 13 · MOTION ────────────────────────────────────────────────
  function motion() {
    let html = sectHeader('13', 'motion', 'Motion.',
      'Three keyframes do all the work. Pulse for "this is alive." Spin for "this is busy." Flow for "this is moving."');

    html += '<div class="grid">';

    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">pulse <em>· 1.6s ease-in-out infinite</em></div></div>' +
      '<div class="card-desc">Slow opacity + glow oscillation. The visual language of &ldquo;running.&rdquo;</div>' +
      '<div class="card-canvas">' +
        '<span class="c-dot running"></span>' +
        '<span class="c-dot running"></span>' +
        '<span class="c-dot running"></span>' +
      '</div>' +
      '<div class="card-foot"><b>Applied to:</b> running run-chip\u2019s left rail · running step dot · active edge glow · active node ember stripe · activity readout pulse.</div>' +
    '</div>';

    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">spin <em>· 0.8s linear infinite</em></div></div>' +
      '<div class="card-desc">A circle missing one quadrant rotating. Lives inside running chips.</div>' +
      '<div class="card-canvas">' +
        '<span class="c-run-chip running"><span class="spinner"></span>Running</span>' +
        '<span class="c-run-chip running sm"><span class="spinner"></span>2m</span>' +
      '</div>' +
      '<div class="card-foot"><b>Border-right</b> is transparent — the spinner inherits chip color so it reads at any state size. <span class="rule">Rule — never spin a non-running thing. The spinner is reserved for actual in-flight work.</span></div>' +
    '</div>';

    html += '<div class="card">' +
      '<div class="card-head"><div class="card-name">flow <em>· 1.4s linear · 2.4s wait</em></div></div>' +
      '<div class="card-desc">Movement along an axis. Two forms: stroke-dashoffset along a live SVG edge, and background-position along a wait-bar.</div>' +
      '<div class="card-canvas col">' +
        '<svg width="240" height="20" viewBox="0 0 240 20">' +
          '<path d="M10,10 H230" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 4" fill="none" style="filter: drop-shadow(0 0 4px var(--accent-glow));">' +
            '<animate attributeName="stroke-dashoffset" from="0" to="-16" dur="1.4s" repeatCount="indefinite"/>' +
          '</path>' +
        '</svg>' +
        '<div style="width:240px;padding:8px 12px;background:color-mix(in oklch, var(--step-wait-wash) 25%, var(--bg-2));border:1px solid color-mix(in oklch, var(--step-wait) 30%, transparent);border-left:3px solid var(--step-wait);border-radius:var(--r-sm);font-family:var(--sans);font-size:11px;color:var(--step-wait-fg);display:flex;align-items:center;gap:10px;">' +
          '<span>Waiting</span>' +
          '<span style="flex:1;height:3px;background:linear-gradient(to right, var(--step-wait) 40%, transparent);background-size:200% 100%;animation:c-flow 2.4s ease-in-out infinite;border-radius:2px;"></span>' +
        '</div>' +
      '</div>' +
      '<div class="card-foot"><b>Live edges</b> on the workflow graph use flow @ 1.4s. <b>Wait bars</b> in trace stream use flow @ 2.4s — slower because waiting is a longer-felt state.</div>' +
    '</div>';

    html += '</div>';

    // Closing summary
    html += '<section style="margin-top: var(--s-7); padding-top: var(--s-6); border-top: 1px solid var(--line);">' +
      '<div style="font-family:var(--mono);font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--fg-faint);">end of catalog</div>' +
      '<h2 style="font-family:var(--serif);font-size:32px;font-style:italic;font-weight:400;letter-spacing:-0.02em;color:var(--fg);margin:6px 0 12px;line-height:1.1;">Two concepts. One ember. Everything else falls out.</h2>' +
      '<p style="font-family:var(--serif);font-size:15px;color:var(--fg-mute);line-height:1.6;max-width:680px;">If you find yourself reaching for a new color, a new chip variant, or a new animation, ask first: am I trying to say something about <em style="color:var(--accent);">runState</em>, about <em style="color:var(--step-execute-fg);">stepKind</em>, or about <em>now</em>? If yes, the vocabulary already exists. If no, the design probably doesn\u2019t need it.</p>' +
      '</section>';

    html += '</section>';
    return html;
  }

  // ── CHAT · PROJECT CHAT FLOAT ──────────────────────────────────
  function chat() {
    const STYLE = '<style>' +
      '.cat-chat-wrap{display:flex;gap:var(--s-5);flex-wrap:wrap;align-items:flex-start;}' +
      '.cat-chat{width:344px;background:linear-gradient(155deg,color-mix(in oklch,var(--bg-3) 34%,transparent),color-mix(in oklch,var(--bg-2) 28%,transparent));-webkit-backdrop-filter:blur(30px) brightness(1.5) saturate(1.6);backdrop-filter:blur(30px) brightness(1.5) saturate(1.6);border:1px solid color-mix(in oklch,var(--fg) 12%,transparent);border-left:3px solid var(--accent);border-radius:var(--r-lg);overflow:hidden;box-shadow:var(--shadow-2),0 0 30px rgba(0,0,0,0.28),inset 0 1px 0 color-mix(in oklch,var(--fg) 16%,transparent);display:flex;flex-direction:column;}' +
      '.cat-chat .hd{background:color-mix(in oklch,var(--bg-3) 26%,transparent);border-bottom:1px solid color-mix(in oklch,var(--fg) 8%,transparent);padding:9px 8px 9px 7px;}' +
      '.cat-chat .hd-top{display:flex;align-items:center;gap:7px;}' +
      '.cat-chat .grip{display:flex;flex-direction:column;gap:3px;padding:2px;opacity:.4;}' +
      '.cat-chat .grip span{display:block;width:11px;height:1.5px;background:var(--fg-mute);border-radius:9999px;}' +
      '.cat-chat .ttl{flex:1;font-family:var(--serif);font-size:15.5px;color:var(--fg);letter-spacing:-0.01em;line-height:1;}' +
      '.cat-chat .ttl .em{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 7px var(--accent-glow);display:inline-block;margin-left:5px;vertical-align:2px;}' +
      '.cat-chat .ctrls{display:flex;gap:1px;}' +
      '.cat-chat .ctrl{width:24px;height:24px;display:flex;align-items:center;justify-content:center;color:var(--fg-mute);border-radius:var(--r-sm);}' +
      '.cat-chat .meta{display:flex;align-items:center;gap:7px;margin-top:7px;margin-left:19px;font-family:var(--mono);font-size:10px;color:var(--fg-mute);}' +
      '.cat-chat .meta .id{color:var(--fg-faint);padding:1px 6px;background:var(--bg);border:1px solid var(--line);border-radius:var(--r-xs);}' +
      '.cat-chat .meta .gd{width:5px;height:5px;border-radius:50%;background:var(--ok);box-shadow:0 0 5px color-mix(in oklch,var(--ok) 60%,transparent);}' +
      '.cat-chat .meta .sep{color:var(--fg-ghost);}' +
      '.cat-chat .body{background:transparent;padding:var(--s-4);display:flex;flex-direction:column;gap:var(--s-4);}' +
      '.cat-chat .day{align-self:center;font-family:var(--mono);font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:var(--fg-faint);}' +
      '.cat-chat .turn{display:flex;flex-direction:column;gap:7px;}' +
      '.cat-chat .turn.user{align-items:flex-end;}' +
      '.cat-chat .bubble{max-width:86%;padding:9px 12px;font-size:13px;line-height:1.55;border-radius:var(--r-lg);background:var(--accent-wash);color:var(--fg);border:1px solid color-mix(in oklch,var(--accent) 32%,transparent);border-bottom-right-radius:var(--r-xs);}' +
      '.cat-chat .speaker{font-family:var(--mono);font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--fg-mute);display:flex;align-items:center;gap:7px;}' +
      '.cat-chat .speaker .ember{width:5px;height:5px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent-glow);}' +
      '.cat-chat .speaker .model{color:var(--fg-faint);font-size:9px;padding:1px 5px;border:1px solid var(--line);border-radius:var(--r-xs);text-transform:none;letter-spacing:0.04em;}' +
      '.cat-chat .prose{color:var(--fg-soft);font-size:13px;line-height:1.6;border-left:2px solid var(--line-strong);padding:1px 0 1px 12px;}' +
      '.cat-chat .prose strong{color:var(--fg);font-weight:600;}' +
      '.cat-chat .prose code{font-family:var(--mono);font-size:11.5px;color:var(--accent);background:var(--accent-wash);padding:1px 5px;border-radius:var(--r-xs);}' +
      '.cat-chat .cur{display:inline-block;width:7px;height:14px;background:var(--accent);margin-left:2px;vertical-align:-2px;box-shadow:0 0 6px var(--accent-glow);animation:cat-blink 1s step-end infinite;}' +
      '@keyframes cat-blink{50%{opacity:0;}}' +
      '.cat-tool{border:1px solid color-mix(in oklch,var(--step-execute) 28%,var(--line-strong));border-radius:var(--r-sm);overflow:hidden;}' +
      '.cat-tool .th{display:flex;align-items:center;gap:8px;padding:6px 9px;background:color-mix(in oklch,var(--step-execute-wash) 28%,var(--bg-2));}' +
      '.cat-tool .tdot{width:6px;height:6px;border-radius:50%;background:var(--step-execute);flex-shrink:0;}' +
      '.cat-tool .tname{font-family:var(--mono);font-size:11px;font-weight:500;color:var(--step-execute-fg);}' +
      '.cat-tool .tsum{font-family:var(--mono);font-size:10px;color:var(--fg-faint);margin-left:auto;}' +
      '.cat-tool .tchev{color:var(--fg-faint);font-size:9px;}' +
      '.cat-tool .tb{padding:8px 10px;background:var(--bg);border-top:1px solid var(--line);font-family:var(--mono);font-size:11px;line-height:1.55;color:var(--fg-mute);white-space:pre-wrap;}' +
      '.cat-tool.pending{border-color:color-mix(in oklch,var(--accent) 32%,transparent);}' +
      '.cat-tool.pending .th{background:color-mix(in oklch,var(--accent-wash) 50%,var(--bg-2));}' +
      '.cat-tool.pending .tdot{background:var(--accent);box-shadow:0 0 5px var(--accent-glow);}' +
      '.cat-tool.pending .tname{color:var(--accent);}' +
      '.cat-spin{width:9px;height:9px;border:1.5px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:cat-spin .7s linear infinite;flex-shrink:0;}' +
      '@keyframes cat-spin{to{transform:rotate(360deg);}}' +
      '.cat-chat .foot{background:color-mix(in oklch,var(--bg-2) 24%,transparent);border-top:1px solid color-mix(in oklch,var(--fg) 8%,transparent);}' +
      '.cat-chat .ctx{height:2px;background:color-mix(in oklch,var(--bg) 50%,transparent);}' +
      '.cat-chat .ctx > i{display:block;height:100%;width:38%;background:var(--ok);}' +
      '.cat-chat .compose{padding:9px 10px 8px;}' +
      '.cat-chat .iw{display:flex;align-items:flex-end;gap:8px;background:var(--bg-1);border:1px solid var(--accent);box-shadow:0 0 0 3px var(--accent-wash);border-radius:var(--r-md);padding:6px 6px 6px 10px;}' +
      '.cat-chat .iw .ico{width:18px;height:18px;color:var(--fg-faint);display:flex;align-items:center;}' +
      '.cat-chat .iw .ph{flex:1;font-size:13px;color:var(--fg);padding:2px 0;}' +
      '.cat-chat .iw .ph .car{display:inline-block;width:1.5px;height:15px;background:var(--accent);vertical-align:-3px;margin-left:1px;animation:cat-blink 1s step-end infinite;}' +
      '.cat-chat .send{width:28px;height:28px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--accent);color:var(--bg);border-radius:var(--r-sm);}' +
      '.cat-chat .fm{display:flex;align-items:center;gap:8px;padding:0 12px 8px;font-family:var(--mono);font-size:9.5px;color:var(--fg-faint);}' +
      '.cat-chat .fm .key{padding:1px 4px;background:var(--bg-3);border:1px solid var(--line-strong);border-radius:var(--r-xs);color:var(--fg-mute);}' +
      '.cat-chat .fm .r{margin-left:auto;}' +
      '.cat-chat .fm .r b{color:var(--fg-mute);font-weight:500;}' +
      '.cat-launch{display:inline-flex;align-items:center;gap:9px;height:38px;padding:0 16px 0 12px;background:color-mix(in oklch,var(--bg-2) 66%,transparent);-webkit-backdrop-filter:blur(20px) saturate(1.4);backdrop-filter:blur(20px) saturate(1.4);color:var(--fg);border:1px solid var(--line-strong);border-left:3px solid var(--accent);border-radius:var(--r-full);box-shadow:var(--shadow-2),0 0 18px var(--accent-glow);}' +
      '.cat-launch .ic{color:var(--accent);display:inline-flex;}' +
      '.cat-launch .lbl{font-family:var(--serif);font-style:italic;font-size:15px;}' +
      '.cat-launch .ember{width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 7px var(--accent-glow);}' +
      '</style>';

    const sendSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    const attachSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
    const dockSvg = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="18" rx="1"/><path d="M14 8h7M14 12h7M14 16h7"/></svg>';
    const expandSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    const closeSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const chatSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

    let html = sectHeader('14', 'chat', 'Project chat, floating.',
      'A single project-level conversation that floats over every page. It reuses the float-panel chrome \u2014 ember spine, drag handle, dock control \u2014 and fills it with the same agent prose and tool blocks the trace stream uses. Drag it anywhere; drop it near the left edge to dock beside the rail.');

    html += STYLE;
    html += '<div class="cat-chat-wrap">';

    // The panel
    html += '<div class="cat-chat">' +
      '<div class="hd">' +
        '<div class="hd-top">' +
          '<span class="grip"><span></span><span></span><span></span></span>' +
          '<span class="ttl">Project chat<span class="em"></span></span>' +
          '<div class="ctrls"><span class="ctrl">' + dockSvg + '</span><span class="ctrl">' + expandSvg + '</span><span class="ctrl">' + closeSvg + '</span></div>' +
        '</div>' +
        '<div class="meta"><span class="gd"></span>scoped to <span class="id">sacrum</span><span class="sep">\u00b7</span>whole project</div>' +
      '</div>' +
      '<div class="body">' +
        '<div class="day">Today</div>' +
        '<div class="turn user"><div class="bubble">Which runs need a human before they can finish?</div></div>' +
        '<div class="turn assistant">' +
          '<div class="speaker"><span class="ember"></span>sacrum<span class="model">orchestrator</span></div>' +
          '<div class="cat-tool"><div class="th"><span class="tdot"></span><span class="tname">query_runs</span><span class="tsum">state: pending_review</span><span class="tchev">\u25be</span></div>' +
            '<div class="tb">\u2192 2 matches\n  03ae9f60  Persist authoring draft   review \u00b7 7h 36m\n  bf68e7ac  Score draft quality       review \u00b7 41m</div></div>' +
          '<div class="prose">Two runs are holding on a review gate. <strong>Persist authoring draft</strong> has been waiting <code>7h 36m</code> \u2014 its acceptance criteria are flagged <code>human</code>. <strong>Score draft quality</strong> just entered review 41m ago.<span class="cur"></span></div>' +
        '</div>' +
      '</div>' +
      '<div class="foot">' +
        '<div class="ctx"><i></i></div>' +
        '<div class="compose"><div class="iw"><span class="ico">' + attachSvg + '</span><span class="ph">Open the first one<span class="car"></span></span><span class="send">' + sendSvg + '</span></div></div>' +
        '<div class="fm"><span><span class="key">\u23ce</span> send \u00b7 <span class="key">\u21e7\u23ce</span> newline</span><span class="r">context <b>34%</b></span></div>' +
      '</div>' +
    '</div>';

    // Side notes: launcher + states
    html += '<div style="flex:1;min-width:240px;max-width:360px;display:flex;flex-direction:column;gap:var(--s-4);">' +
      '<div class="card" style="margin:0;">' +
        '<div class="card-head"><div class="card-name">Launcher <em>collapsed state</em></div></div>' +
        '<div class="card-desc">When closed, the panel folds into an ember-spined pill at the bottom-left \u2014 the only persistent entry point.</div>' +
        '<div class="card-canvas start"><span class="cat-launch"><span class="ic">' + chatSvg + '</span><span class="lbl">Ask sacrum</span><span class="ember"></span></span></div>' +
      '</div>' +
      '<div class="card" style="margin:0;">' +
        '<div class="card-head"><div class="card-name">Tool block <em>pending \u2192 done</em></div></div>' +
        '<div class="card-canvas col start" style="gap:var(--s-3);align-items:stretch;">' +
          '<div class="cat-tool pending"><div class="th"><span class="cat-spin"></span><span class="tname">search_tasks</span><span class="tsum">running\u2026</span></div></div>' +
          '<div class="cat-tool"><div class="th"><span class="tdot"></span><span class="tname">search_tasks</span><span class="tsum">3 active runs</span><span class="tchev">\u25be</span></div><div class="tb">\u2192 3 active runs\n  03ae9f60  durable write fan-out   +41m\n  7c1102de  OpenRouter stream       +9m</div></div>' +
        '</div>' +
      '</div>' +
    '</div>';

    html += '</div>'; // /cat-chat-wrap

    html += '<div class="card-foot" style="margin-top:var(--s-4);"><b>Project-scoped, single session.</b> No per-task threads \u2014 the chat always answers for the whole project, so its memory follows you between pages. ' +
      '<span class="rule">Rule \u2014 the ember spine and streaming cursor mark this as the one live, conversational surface. Tool calls borrow the <em style="font-style:italic;">execute</em> violet, never a new colour.</span></div>';

    html += '</section>';
    return html;
  }

  // ── Append to page ──────────────────────────────────────────
  const continueDiv = document.getElementById('catalogContinue');
  if (continueDiv) {
    continueDiv.outerHTML = graph() + traces() + chat() + filters() + switches() + motion();
  } else {
    document.getElementById('catalogBody').insertAdjacentHTML('beforeend',
      graph() + traces() + chat() + filters() + switches() + motion());
  }
})();

// ── Interactive: hue wheel slider ─────────────────────────────
(function () {
  'use strict';

  const STEP_KINDS = [
    { id: 'execute', hue: 285 }, { id: 'eval', hue: 200 },
    { id: 'route', hue: 135 },   { id: 'human', hue: 70 },
    { id: 'wait', hue: 250 },
  ];
  const STATUS_HUES = [
    { id: 'err', hue: 25 }, { id: 'warn', hue: 75 },
    { id: 'ok', hue: 145 }, { id: 'info', hue: 220 },
  ];
  const ALL = STEP_KINDS.concat(STATUS_HUES);

  function circDist(a, b) {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
  }
  function pos(deg, cx, cy, r) {
    const rad = deg * Math.PI / 180;
    return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
  }

  function setup() {
    const hueSlider = document.getElementById('hueSlider');
    if (!hueSlider) return; // wheel not on this page

    const lSlider = document.getElementById('lSlider');
    const cSlider = document.getElementById('cSlider');
    const sample = document.getElementById('hueSample');
    const degSpan = document.getElementById('hueValDeg');
    const lVal = document.getElementById('lVal');
    const cVal = document.getElementById('cVal');
    const lRead = document.getElementById('lRead');
    const cRead = document.getElementById('cRead');
    const hueRead = document.getElementById('hueRead');
    const candRing = document.getElementById('candRing');
    const candLine = document.getElementById('candLine');
    const candDot = document.getElementById('candDot');

    function update() {
      const h = Number(hueSlider.value);
      const l = Number(lSlider.value);
      const c = Number(cSlider.value);
      const lStr = l.toFixed(2);
      const cStr = c.toFixed(3);
      const color = 'oklch(' + lStr + ' ' + cStr + ' ' + h + ')';

      if (lRead) lRead.textContent = lStr;
      if (cRead) cRead.textContent = cStr;
      if (hueRead) hueRead.textContent = h + '°';
      if (lVal) lVal.textContent = lStr;
      if (cVal) cVal.textContent = cStr;
      degSpan.textContent = h;
      sample.style.background = color;

      const cx = 200, cy = 200, r = 140;
      const p = pos(h, cx, cy, r);
      candRing.setAttribute('cx', p.x);
      candRing.setAttribute('cy', p.y);
      candLine.setAttribute('x2', p.x);
      candLine.setAttribute('y2', p.y);
      candRing.setAttribute('stroke', color);
      candLine.setAttribute('stroke', color);
      if (candDot) {
        candDot.setAttribute('cx', p.x);
        candDot.setAttribute('cy', p.y);
        candDot.setAttribute('fill', color);
      }

      // Recompute distances (hue separation only)
      ALL.forEach(c2 => {
        const d = circDist(h, c2.hue);
        const row = document.getElementById('dist-' + c2.id);
        if (!row) return;
        const dCell = row.querySelector('.d');
        dCell.textContent = Math.round(d) + '°';
        if (d < 30) {
          row.style.background = 'color-mix(in oklch, var(--err-wash) 50%, transparent)';
          row.style.color = 'var(--err)';
          dCell.style.color = 'var(--err)';
          dCell.style.fontWeight = '600';
        } else if (d < 50) {
          row.style.background = 'color-mix(in oklch, var(--warn-wash) 25%, transparent)';
          row.style.color = '';
          dCell.style.color = 'var(--warn)';
          dCell.style.fontWeight = '500';
        } else {
          row.style.background = '';
          row.style.color = '';
          dCell.style.color = '';
          dCell.style.fontWeight = '';
        }
      });
    }

    [hueSlider, lSlider, cSlider].forEach(s => { if (s) s.addEventListener('input', update); });
    update();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setTimeout(setup, 50);
  }
})();
