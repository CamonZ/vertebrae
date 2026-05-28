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
      '<div class="card-head"><div class="card-name">GraphEdge</div></div>' +
      '<div class="card-desc">SVG bezier between node anchors. Variants: neutral (line-strong) and live (animated dashed accent with glow).</div>' +
      '<div class="card-canvas" style="min-height: 140px;">' +
        '<svg width="100%" height="120" viewBox="0 0 320 120">' +
          '<defs>' +
            '<marker id="ar1" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--line-strong)"/></marker>' +
          '</defs>' +
          // Neutral edge
          '<path d="M30,40 C90,40 110,40 150,40" stroke="var(--line-strong)" stroke-width="1.5" fill="none" marker-end="url(#ar1)"/>' +
          '<text x="22" y="34" font-family="var(--mono)" font-size="9" fill="var(--fg-faint)">A</text>' +
          '<text x="155" y="34" font-family="var(--mono)" font-size="9" fill="var(--fg-faint)">B</text>' +
          '<text x="90" y="58" font-family="var(--mono)" font-size="9" fill="var(--fg-faint)" text-anchor="middle">neutral</text>' +
          // Live edge
          '<path class="live-edge" d="M30,90 C90,90 110,90 150,90" stroke="var(--accent)" stroke-width="2" stroke-dasharray="4 4" fill="none" style="filter: drop-shadow(0 0 4px var(--accent-glow));">' +
            '<animate attributeName="stroke-dashoffset" from="0" to="-16" dur="1.4s" repeatCount="indefinite"/>' +
          '</path>' +
          '<text x="22" y="84" font-family="var(--mono)" font-size="9" fill="var(--fg-faint)">A</text>' +
          '<text x="155" y="84" font-family="var(--mono)" font-size="9" fill="var(--accent)">B</text>' +
          '<text x="90" y="108" font-family="var(--mono)" font-size="9" fill="var(--accent)" text-anchor="middle">live · flowing</text>' +
        '</svg>' +
      '</div>' +
      '<div class="card-foot"><b>Live</b> marks the edge the current run came through; animated dash + ember filter-shadow.</div>' +
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
      '<div class="card-foot"><b>Buttons:</b> zoom-in · zoom-out · fit-to-content.</div>' +
    '</div>';

    html += '</div></section>';
    return html;
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

  // ── Append to page ──────────────────────────────────────────
  const continueDiv = document.getElementById('catalogContinue');
  if (continueDiv) {
    continueDiv.outerHTML = graph() + traces() + filters() + switches() + motion();
  } else {
    document.getElementById('catalogBody').insertAdjacentHTML('beforeend',
      graph() + traces() + filters() + switches() + motion());
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
