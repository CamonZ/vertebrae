/* ──────────────────────────────────────────────────────────────────
   Vertebrae · Hearth — Tasks v2 (interactive)

   Concepts kept distinct:
     • stepKind  — the kind of step in a workflow:
                   'execute' | 'eval' | 'route' | 'human' | 'wait' | null
                   This is the WORKFLOW POSITION. Drives hue.
     • runState  — the state of the last task run:
                   'running' | 'waiting' | 'queued' |
                   'completed' | 'cancelled' | 'stopped' | null
                   Only running/waiting/queued surface as a chip.
                   Terminal states (completed/cancelled/stopped) and
                   never-run (null) show no chip.
   ────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── Data ────────────────────────────────────────────────────────
  // Provided by tasks-data.js (window.HEARTH_DATA) — load it before this script.
  if (!window.HEARTH_DATA) { console.error("HEARTH_DATA missing — load tasks-data.js first"); return; }
  const TASKS = window.HEARTH_DATA.TASKS;
  const byId = window.HEARTH_DATA.byId;

  // ── Helpers from shared module ─────────────────────────────────
  const isActiveRun = window.HEARTH_DATA.isActiveRun;
  const isTerminalRun = window.HEARTH_DATA.isTerminalRun;
  const ancestorIds = window.HEARTH_DATA.ancestorIds;


  // ── State ───────────────────────────────────────────────────────
  const state = {
    selectedId: '40628099',
    expanded: new Set(['2b064abb', '40628099']),
    sectionsCollapsed: new Set(['sec-spec', 'sec-deps', 'sec-code', 'sec-details']),
    scope: 'all',
    query: '',
  };

  // ── Helpers ───────────────────────────────────────────────────
  function escape(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Filtering ────────────────────────────────────────────────
  function matchesScope(t) {
    switch (state.scope) {
      case 'active':  return t.runState === 'running' || t.runState === 'waiting';
      case 'waiting': return t.runState === 'waiting';
      case 'blocked': return Array.isArray(t.blockedBy) && t.blockedBy.length > 0;
      case 'recent':  return /[hm]$/.test(t.when || '');
      case 'mine':    return (t.tags || []).some((x) => /authoring|chat|live/.test(x));
      case 'queued':  return t.runState === 'queued';
      case 'done':    return t.runState === 'completed';
      default:        return true;
    }
  }
  function matchesQuery(t) {
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    if (t.title.toLowerCase().indexOf(q) !== -1) return true;
    if (t.id.indexOf(q) !== -1) return true;
    return (t.tags || []).some((x) => x.toLowerCase().indexOf(q) !== -1);
  }
  function isFiltering() { return state.scope !== 'all' || !!state.query; }

  function visibleIds() {
    if (isFiltering()) {
      const include = new Set();
      TASKS.forEach((t) => {
        if (matchesScope(t) && matchesQuery(t)) {
          include.add(t.id);
          ancestorIds(t).forEach((a) => include.add(a));
        }
      });
      return TASKS.filter((t) => include.has(t.id)).map((t) => t.id);
    }
    const out = [];
    function visit(id) {
      const t = byId[id]; if (!t) return;
      out.push(id);
      if (state.expanded.has(id) && t.children) t.children.forEach(visit);
    }
    TASKS.filter((t) => !t.parent).forEach((r) => visit(r.id));
    return out;
  }

  function scopeCounts() {
    let running = 0, waiting = 0, blocked = 0, mine = 0, queued = 0, done = 0;
    TASKS.forEach((t) => {
      if (t.runState === 'running') running++;
      if (t.runState === 'waiting') waiting++;
      if (Array.isArray(t.blockedBy) && t.blockedBy.length) blocked++;
      if ((t.tags || []).some((x) => /authoring|chat|live/.test(x))) mine++;
      if (t.runState === 'queued') queued++;
      if (t.runState === 'completed') done++;
    });
    return { running, waiting, blocked, mine, queued, done, active: running + waiting };
  }

  // ── Row pieces ────────────────────────────────────────────────
  const GLYPHS = ['◈', '◇', '·'];

  // Run-state chip — only for running/waiting/queued. Terminal & null = nothing.
  function runChipHtml(t) {
    if (!isActiveRun(t.runState)) return '';
    const map = {
      running: { cls: 'running', label: 'Running', spinner: true },
      waiting: { cls: 'waiting', label: 'Waiting', clock: true },
      queued:  { cls: 'queued',  label: 'Queued' },
    };
    const m = map[t.runState];
    const runtime = t.runtime ? '<span class="runtime"> · ' + escape(t.runtime) + '</span>' : '';
    const lead =
      m.spinner ? '<span class="spinner"></span>' :
      m.clock ? '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' :
      '<span class="qdot"></span>';
    return '<span class="run-chip ' + m.cls + '">' + lead + escape(m.label) + runtime + '</span>';
  }

  // Workflow pipeline strip — segments hued by stepKind, dimmed by run state.
  // No "X of Y" count — workflows are graphs, not linear.
  function pipelineHtml(t) {
    if (!t.pipeline || !t.pipeline.length) return '';
    const segs = t.pipeline.map((s) =>
      '<span class="seg kind-' + (s.kind || 'none') + ' s-' + (s.state || 'queued') + '"></span>'
    ).join('');
    return '<span class="sep">·</span><span class="pipeline" title="Workflow shape (kind = hue, state = brightness)">' + segs + '</span>';
  }

  function priorityHtml(t) {
    if (!t.priority) return '';
    const sym = t.priority === 'hi' ? '↑' : t.priority === 'md' ? '→' : '↓';
    return '<span class="pri ' + t.priority + '" title="' + t.priority + ' priority">' + sym + '</span>';
  }

  // Per-state breakdown for tickets — replaces "X of 6" count
  function breakdownHtml(t) {
    if (!t.children || !t.children.length) return '';
    let done = 0, running = 0, waiting = 0, queued = 0;
    t.children.forEach((cid) => {
      const c = byId[cid]; if (!c) return;
      if (c.runState === 'completed') done++;
      else if (c.runState === 'running') running++;
      else if (c.runState === 'waiting') waiting++;
      else if (c.runState === 'queued') queued++;
    });
    const bits = [];
    if (done)    bits.push('<span style="color:var(--ok);">✓ ' + done + '</span>');
    if (running) bits.push('<span style="color:var(--accent);">▶ ' + running + '</span>');
    if (waiting) bits.push('<span style="color:var(--warn);">⏸ ' + waiting + '</span>');
    if (queued)  bits.push('<span>○ ' + queued + '</span>');
    if (!bits.length) return '';
    return '<span class="sep">·</span><span class="breakdown">' + bits.join(' <span style="color:var(--fg-ghost);">·</span> ') + '</span>';
  }

  function idChipHtml(id) {
    return '<span class="id-chip" data-id="' + id + '" title="click to copy">' +
      '<span class="id-text">' + escape(id) + '</span>' +
      '<svg class="copy-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
      '<svg class="ok-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' +
      '</span>';
  }

  function rowHtml(t) {
    const sel = t.id === state.selectedId ? ' sel' : '';
    const expanded = state.expanded.has(t.id);
    const hasChildren = (t.children && t.children.length) || (t.childCount && t.childCount > 0);
    const chev = hasChildren ? (expanded ? '▾' : '▸') : '';
    const glyph = GLYPHS[t.level] || '·';
    const isCompleted = t.runState === 'completed';

    // indent guides
    let indent = '<div class="indent">';
    if (t.level >= 1) indent += '<span class="g l1"></span>';
    if (t.level >= 2) indent += '<span class="g l2"></span>';
    indent += '</div>';

    // meta line for epics & tickets
    let meta = '';
    if (t.level <= 1) {
      const tagBits = (t.tags || []).slice(0, 3).map((x) => '<span class="tag">' + escape(x) + '</span>').join(' ');
      const ccount = (t.childCount || (t.children && t.children.length) || 0);
      const ccLabel = t.level === 0
        ? (ccount === 1 ? '1 ticket' : ccount + ' tickets')
        : (ccount === 1 ? '1 task' : ccount + ' tasks');
      meta = '<div class="meta">' +
        (ccount ? '<span>' + ccLabel + '</span>' + (tagBits ? '<span class="sep">·</span>' : '') : '') +
        tagBits +
        pipelineHtml(t) +
        breakdownHtml(t) +
        '</div>';
    }

    // Glyph emphasis on selected ticket / running task
    const glyphStyle =
      (t.id === state.selectedId || t.runState === 'running')
        ? ' style="color:var(--accent);"' : '';

    const titleClass = isCompleted ? 'title done' : 'title';

    return (
      '<div class="row l' + t.level + sel + (isCompleted ? ' completed' : '') + '" data-id="' + t.id + '">' +
      indent +
      '<div class="body">' +
      '<div class="top">' +
      '<span class="chev" data-action="toggle">' + chev + '</span>' +
      '<span class="glyph"' + glyphStyle + '>' + glyph + '</span>' +
      '<span class="' + titleClass + '">' + escape(t.title) + '</span>' +
      priorityHtml(t) +
      '</div>' +
      meta +
      '</div>' +
      '<div class="right">' +
      '<div class="chip-slot">' + runChipHtml(t) + '</div>' +
      idChipHtml(t.id) +
      '<div class="when">' + escape(t.when || '') + '</div>' +
      '</div>' +
      '</div>'
    );
  }

  // ── Detail panel ──────────────────────────────────────────────
  function heroDotsHtml(t) {
    if (!t.children || !t.children.length) return '';
    // No connecting pipe-lines — graph engines can loop. Just pellets.
    return t.children.map((cid) => {
      const c = byId[cid]; if (!c) return '';
      let cls = 'queued';
      if (c.runState === 'completed') cls = 'done';
      else if (c.runState === 'running') cls = 'running';
      else if (c.runState === 'waiting') cls = 'waiting';
      else if (c.runState === 'cancelled' || c.runState === 'stopped') cls = 'stopped';
      const kindCls = c.stepKind ? ' kind-' + c.stepKind : '';
      return '<span class="dot ' + cls + kindCls + '" data-id="' + c.id + '" title="' + escape(c.title) + (c.runState ? ' — ' + c.runState : '') + '"></span>';
    }).join('');
  }

  function heroStatusHtml(t) {
    // Edge = stepKind hue (workflow position). Title = runState.
    const kind = t.stepKind || null;
    const edge = kind ? 'var(--step-' + kind + ')' : 'var(--line-strong)';

    // Choose run state presentation
    let stateLabel = null, stateColor = 'var(--fg-mute)', icoSvg = '', icoColor = 'var(--fg-mute)';
    if (t.runState === 'running') {
      stateLabel = 'Running'; stateColor = 'var(--accent)'; icoColor = 'var(--accent)';
      icoSvg = '<span class="spinner" style="width:11px;height:11px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;display:inline-block;animation:spin 0.8s linear infinite;"></span>';
    } else if (t.runState === 'waiting') {
      stateLabel = 'Waiting'; stateColor = 'var(--warn)'; icoColor = 'var(--warn)';
      icoSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    } else if (t.runState === 'queued') {
      stateLabel = 'Queued'; stateColor = 'var(--fg-mute)';
      icoSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9" opacity="0.4"/></svg>';
    } else if (t.runState === 'completed') {
      stateLabel = 'Completed'; stateColor = 'var(--ok)'; icoColor = 'var(--ok)';
      icoSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
    } else if (t.runState === 'cancelled' || t.runState === 'stopped') {
      stateLabel = t.runState === 'cancelled' ? 'Cancelled' : 'Stopped';
      stateColor = 'var(--fg-faint)';
      icoSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>';
    } else {
      stateLabel = 'No active run'; stateColor = 'var(--fg-faint)';
      icoSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" opacity="0.7"><circle cx="12" cy="12" r="9"/></svg>';
    }

    // Step kind label — workflow position
    const stepLabel = kind
      ? '<span class="sep">·</span><span class="step-pos" style="color:var(--step-' + kind + '-fg);">step <em style="font-family:var(--serif);font-style:italic;color:var(--step-' + kind + '-fg);">' + kind + '</em></span>'
      : '';

    const runtimeBit = t.runtime && (t.runState === 'running' || t.runState === 'waiting')
      ? '<span class="sep">·</span><span class="runtime">' + escape(t.runtime) + '</span>'
      : '';

    // Per-state breakdown (replaces linear X/Y)
    let breakdown = '';
    if (t.children && t.children.length) {
      let done = 0, running = 0, waiting = 0, queued = 0;
      t.children.forEach((cid) => {
        const c = byId[cid]; if (!c) return;
        if (c.runState === 'completed') done++;
        else if (c.runState === 'running') running++;
        else if (c.runState === 'waiting') waiting++;
        else if (c.runState === 'queued') queued++;
      });
      const bits = [];
      if (done) bits.push('<span style="color:var(--ok);">' + done + ' done</span>');
      if (running) bits.push('<span style="color:var(--accent);">' + running + ' running</span>');
      if (waiting) bits.push('<span style="color:var(--warn);">' + waiting + ' waiting</span>');
      if (queued) bits.push('<span style="color:var(--fg-mute);">' + queued + ' queued</span>');
      breakdown = bits.length
        ? '<div class="hero-breakdown">' + bits.join(' <span style="color:var(--fg-ghost);">·</span> ') + '</div>'
        : '';
    }

    const dots = heroDotsHtml(t);
    const pipeCap = t.runs
      ? '<span class="pipe-cap">' + t.runs.this.runs + ' runs · ' + t.runs.this.attempts + ' attempts</span>'
      : '';

    return (
      '<div class="hero-status" style="border-left-color:' + edge + ';">' +
      '<div class="hero-line">' +
      '<span class="ico" style="color:' + icoColor + ';">' + icoSvg + '</span>' +
      '<span class="state" style="color:' + stateColor + ';">' + escape(stateLabel) + '</span>' +
      runtimeBit +
      stepLabel +
      '</div>' +
      breakdown +
      (dots ? '<div class="hero-pipe">' + dots + pipeCap + '</div>' : '') +
      '</div>'
    );
  }

  function sectionHtml(id, title, count, body) {
    const collapsed = state.sectionsCollapsed.has(id);
    return (
      '<div class="sec' + (collapsed ? ' collapsed' : '') + '" id="' + id + '">' +
      '<div class="sec-hd" data-section="' + id + '">' +
      '<span class="sec-chev">▾</span>' +
      '<span class="sec-name' + (id === 'sec-children' ? ' children' : '') + '">' + escape(title) + '</span>' +
      (count != null ? '<span class="sec-count">' + count + '</span>' : '') +
      '</div>' +
      '<div class="sec-inner">' + body + '</div>' +
      '</div>'
    );
  }

  function childRunPill(c) {
    if (!isActiveRun(c.runState)) return '';
    return '<span class="run-chip ' + c.runState + ' sm">' +
      (c.runState === 'running' ? '<span class="spinner"></span>' : '') +
      escape(c.runState[0].toUpperCase() + c.runState.slice(1)) +
      (c.runtime ? ' · ' + escape(c.runtime) : '') +
      '</span>';
  }

  function childrenSectionBody(t) {
    if (!t.children || !t.children.length) {
      return '<div class="prose" style="font-style:italic;color:var(--fg-faint);">No children yet.</div>';
    }
    return t.children.map((cid) => {
      const c = byId[cid]; if (!c) return '';
      const completed = c.runState === 'completed';
      const isRunning = c.runState === 'running';
      const stepHue = c.stepKind ? ' style="background:var(--step-' + c.stepKind + ');"' : '';
      const nameStyle = isRunning ? ' style="color:var(--fg);"' : (completed ? ' style="color:var(--fg-mute);"' : '');
      return (
        '<div class="child' + (isRunning ? ' running' : '') + '" data-id="' + c.id + '">' +
        '<span class="cdot"' + stepHue + '></span>' +
        '<span class="cname"' + nameStyle + '>' + escape(c.title) + '</span>' +
        '<span class="cright">' +
        childRunPill(c) +
        idChipHtml(c.id) +
        '</span>' +
        '</div>'
      );
    }).join('');
  }

  function specSectionBody(t) {
    let html = '';
    if (t.goal) html += '<div class="sub-lbl">Goal</div><div class="prose"><p>' + escape(t.goal) + '</p></div>';
    if (t.description) html += '<div class="sub-lbl">Description</div><div class="prose"><p>' + escape(t.description) + '</p></div>';
    if (t.constraints && t.constraints.length) {
      html += '<div class="sub-lbl">Constraints</div><div class="prose"><ul>' +
        t.constraints.map((c) => '<li>' + escape(c) + '</li>').join('') + '</ul></div>';
    }
    if (t.desired) html += '<div class="sub-lbl">Desired behavior</div><div class="prose"><p>' + escape(t.desired) + '</p></div>';
    if (!html) html = '<div class="prose" style="font-style:italic;color:var(--fg-faint);">No spec authored yet.</div>';
    return html;
  }

  function depsSectionBody(t) {
    const parent = t.parent ? byId[t.parent] : null;
    const blocked = (t.blockedBy || []).map((bid) => byId[bid]).filter(Boolean);
    let html = '';
    if (parent) {
      html += '<div class="sub-lbl">Parent</div>' +
        '<div class="dep-row" data-action="navigate" data-id="' + parent.id + '">' +
        idChipHtml(parent.id) +
        '<span class="dep-title">' + escape(parent.title) + '</span>' +
        '</div>';
    }
    if (blocked.length) {
      html += '<div class="sub-lbl">Blocked by</div>' +
        blocked.map((b) =>
          '<div class="dep-row" data-action="navigate" data-id="' + b.id + '">' +
          idChipHtml(b.id) +
          '<span class="dep-title">' + escape(b.title) + '</span>' +
          '</div>'
        ).join('');
    }
    if (!html) html = '<div class="prose" style="font-style:italic;color:var(--fg-faint);">No dependencies.</div>';
    return html;
  }

  function detailsSectionBody(t) {
    const levelName = ['Epic', 'Ticket', 'Task'][t.level];
    const pri = t.priority === 'hi' ? '<span style="color:var(--err);">High ↑</span>' :
      t.priority === 'md' ? '<span style="color:var(--warn);">Medium →</span>' :
      t.priority === 'lo' ? '<span style="color:var(--fg-faint);">Low ↓</span>' : 'None';
    const stepLabel = t.stepKind
      ? '<span style="color:var(--step-' + t.stepKind + '-fg);font-family:var(--serif);font-style:italic;">' + t.stepKind + '</span>'
      : '<span style="color:var(--fg-faint);">none</span>';
    return (
      '<div class="field-row"><span class="k">Level</span><span class="v">' + escape(levelName) + '</span></div>' +
      '<div class="field-row"><span class="k">Step kind</span><span class="v">' + stepLabel + '</span></div>' +
      '<div class="field-row"><span class="k">Priority</span><span class="v">' + pri + '</span></div>' +
      '<div class="field-row"><span class="k">Updated</span><span class="v">' + escape(t.when || '—') + '</span></div>' +
      '<div class="field-row"><span class="k">Tags</span><span class="v">' + ((t.tags || []).join(' · ') || '<span style="color:var(--fg-faint);">none</span>') + '</span></div>'
    );
  }

  function detailHtml(t) {
    if (!t) {
      return '<div style="padding:var(--s-8);color:var(--fg-faint);font-style:italic;font-family:var(--serif);">No task selected.</div>';
    }
    const levelName = ['Epic', 'Ticket', 'Task'][t.level];
    const parent = t.parent ? byId[t.parent] : null;

    let titleHtml = escape(t.title);
    if (t.level === 1) {
      titleHtml = titleHtml.replace(/(live chat runner|JWT service|chat runner|OpenRouter|work breakdown|tracker operation tools|chat sessions)/i, '<em>$1</em>');
    }

    const isLive = t.runState === 'running' || t.runState === 'waiting';
    const actions =
      '<div class="detail-actions">' +
      (isLive
        ? '<button class="ctrl stop" title="Stop"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>'
        : '<button class="ctrl" title="Run"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>') +
      '<button class="ctrl" title="Chat"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>' +
      '<button class="ctrl" title="Open in new tab"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>' +
      '<button class="ctrl" data-action="deselect" title="Close"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
      '</div>';

    const childCount = (t.children && t.children.length) || 0;

    return (
      '<div class="detail-head">' +
      '<div class="detail-top">' +
      '<div class="detail-title">' + titleHtml + '</div>' +
      actions +
      '</div>' +
      '<div class="detail-id-row">' +
      idChipHtml(t.id) +
      '<span class="sep">·</span>' +
      '<span>' + escape(levelName.toLowerCase()) + '</span>' +
      (parent ? '<span class="sep">·</span><span>under <em data-action="navigate" data-id="' + parent.id + '" style="color:var(--fg-mute);font-style:italic;cursor:pointer;">' + escape(parent.title) + '</em></span>' : '') +
      '</div>' +
      heroStatusHtml(t) +
      '</div>' +

      '<div class="detail-body">' +
      (childCount ? sectionHtml('sec-children', 'Children', childCount, childrenSectionBody(t)) : '') +
      sectionHtml('sec-spec', 'Spec', null, specSectionBody(t)) +
      sectionHtml('sec-deps', 'Dependencies', (parent ? 1 : 0) + ((t.blockedBy || []).length), depsSectionBody(t)) +
      sectionHtml('sec-code', 'Code', 0, '<div class="prose" style="font-style:italic;color:var(--fg-faint);">No code references yet.</div>') +
      sectionHtml('sec-details', 'Details', null, detailsSectionBody(t)) +
      (t.runs
        ? '<div style="padding: var(--s-3) var(--s-5) var(--s-5);"><button class="traces-link" data-action="traces"><span>Explore <em style="color:var(--fg);font-family:var(--serif);font-style:italic;">' + t.runs.subtree.runs + '</em> subtree runs · ' + t.runs.subtree.attempts + ' attempts</span><span class="arr">→</span></button></div>'
        : '') +
      '</div>' +

      '<div class="detail-foot">' +
      '<span style="font-family:var(--mono);font-size:10px;color:var(--fg-faint);">esc · close</span>' +
      '<span style="margin-left:auto;"></span>' +
      '<button class="btn ghost sm">＋ Add task</button>' +
      '<button class="btn sm">⊙ Inspect</button>' +
      '</div>'
    );
  }

  // ── Scope chip renderer ────────────────────────────────────────
  function renderScope() {
    const c = scopeCounts();
    const items = [
      { key: 'active',  label: 'Active',  n: c.active, pulse: true },
      { key: 'waiting', label: 'Waiting', n: c.waiting },
      { key: 'blocked', label: 'Blocked', n: c.blocked },
      { key: 'recent',  label: 'Recent' },
      { key: 'mine',    label: 'Mine',    n: c.mine },
      { sep: true },
      { key: 'queued',  label: 'Queued',  n: c.queued },
      { key: 'done',    label: 'Done',    n: c.done },
    ];
    document.getElementById('scopeChips').innerHTML = items.map((it) => {
      if (it.sep) return '<span class="scope-sep"></span>';
      const active = state.scope === it.key;
      const n = it.n != null
        ? '<span class="n">' + (active && it.pulse ? '<span class="pulse"></span>' : '') + it.n + '</span>'
        : '';
      return '<span class="scope' + (active ? ' active' : '') + '" data-scope="' + it.key + '">' + escape(it.label) + ' ' + n + '</span>';
    }).join('');
  }

  function renderActivity() {
    const c = scopeCounts();
    const total = TASKS.length;
    const roots = TASKS.filter((t) => !t.parent).length;
    document.getElementById('activityLive').innerHTML = '<span class="pulse"></span>' + c.running + ' running';
    document.getElementById('activityTotal').innerHTML = '<b>' + total + '</b> tasks <span style="color:var(--fg-ghost);">·</span> ' + roots + ' roots';
  }

  function renderList() {
    const ids = visibleIds();
    const list = document.getElementById('list');
    list.innerHTML = ids.length
      ? ids.map((id) => rowHtml(byId[id])).join('')
      : '<div style="padding:var(--s-8) var(--s-5);font-family:var(--serif);font-style:italic;color:var(--fg-faint);">No tasks match that filter.</div>';
  }
  function renderDetail() {
    document.getElementById('detail').innerHTML = detailHtml(byId[state.selectedId]);
  }
  function renderAll() { renderScope(); renderActivity(); renderList(); renderDetail(); }

  // ── Actions ────────────────────────────────────────────────────
  function selectTask(id) {
    if (!byId[id]) return;
    state.selectedId = id;
    ancestorIds(byId[id]).forEach((a) => state.expanded.add(a));
    renderList(); renderDetail(); scrollSelectedIntoView();
  }
  function toggleExpand(id) {
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    renderList();
  }
  function setScope(key) { state.scope = key; renderScope(); renderList(); }
  function setQuery(q) { state.query = q || ''; renderList(); }
  function toggleSection(id) {
    if (state.sectionsCollapsed.has(id)) state.sectionsCollapsed.delete(id); else state.sectionsCollapsed.add(id);
    renderDetail();
  }
  function scrollSelectedIntoView() {
    const row = document.querySelector('.row.sel'); if (!row) return;
    const list = document.getElementById('list');
    const rRect = row.getBoundingClientRect(), lRect = list.getBoundingClientRect();
    if (rRect.top < lRect.top + 8 || rRect.bottom > lRect.bottom - 8) {
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
  function copyId(id, el) {
    function flash() {
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1100);
    }
    // Modern API — needs document focus
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id).then(flash).catch(() => {
        legacyCopy(id) && flash();
      });
    } else if (legacyCopy(id)) {
      flash();
    }
  }
  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  // ── Event wiring ───────────────────────────────────────────────
  function onClickAnywhere(e) {
    // 1. ID chip → copy to clipboard, never selects/navigates
    const idChip = e.target.closest('.id-chip');
    if (idChip) {
      e.stopPropagation();
      copyId(idChip.dataset.id, idChip);
      return;
    }
  }
  function onListClick(e) {
    if (e.target.closest('.id-chip')) return; // handled above
    const chev = e.target.closest('.chev[data-action="toggle"]');
    const row = e.target.closest('.row');
    if (chev && row) { e.stopPropagation(); toggleExpand(row.dataset.id); return; }
    if (row) selectTask(row.dataset.id);
  }
  function onDetailClick(e) {
    if (e.target.closest('.id-chip')) return; // handled above
    const nav = e.target.closest('[data-action="navigate"]');
    if (nav && nav.dataset.id) { selectTask(nav.dataset.id); return; }
    const child = e.target.closest('.child');
    if (child && child.dataset.id) { selectTask(child.dataset.id); return; }
    const dot = e.target.closest('.dot[data-id]');
    if (dot) { selectTask(dot.dataset.id); return; }
    const sec = e.target.closest('.sec-hd');
    if (sec && sec.dataset.section) { toggleSection(sec.dataset.section); return; }
    const close = e.target.closest('[data-action="deselect"]');
    if (close) { state.selectedId = null; renderList(); renderDetail(); }
  }
  function onScopeClick(e) {
    const chip = e.target.closest('.scope[data-scope]'); if (!chip) return;
    setScope(chip.dataset.scope === state.scope ? 'all' : chip.dataset.scope);
  }
  function onKey(e) {
    const inSearch = document.activeElement === document.getElementById('search');
    if (e.key === 'Escape') {
      if (inSearch) {
        document.getElementById('search').blur();
        if (state.query) { document.getElementById('search').value = ''; setQuery(''); }
        return;
      }
      state.selectedId = null; renderList(); renderDetail();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const s = document.getElementById('search'); s.focus(); s.select();
    } else if (e.key === '/' && !inSearch) {
      e.preventDefault();
      document.getElementById('search').focus();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && state.selectedId && !inSearch) {
      e.preventDefault();
      const ids = visibleIds(); let i = ids.indexOf(state.selectedId); if (i < 0) return;
      i = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
      selectTask(ids[i]);
    } else if (e.key === 'ArrowLeft' && state.selectedId && !inSearch) {
      const t = byId[state.selectedId];
      if (state.expanded.has(t.id) && t.children && t.children.length) toggleExpand(t.id);
      else if (t.parent) selectTask(t.parent);
    } else if (e.key === 'ArrowRight' && state.selectedId && !inSearch) {
      const t = byId[state.selectedId];
      if (t.children && t.children.length) {
        if (!state.expanded.has(t.id)) toggleExpand(t.id); else selectTask(t.children[0]);
      }
    }
  }

  function init() {
    document.addEventListener('click', onClickAnywhere, true); // capture phase, handles all id chips
    document.getElementById('list').addEventListener('click', onListClick);
    document.getElementById('detail').addEventListener('click', onDetailClick);
    document.getElementById('scopeChips').addEventListener('click', onScopeClick);
    document.getElementById('search').addEventListener('input', (e) => setQuery(e.target.value));
    document.addEventListener('keydown', onKey);
    // Hash → focus task (from board-v2)
    if (location.hash && location.hash.length > 1) {
      const id = location.hash.slice(1);
      if (byId[id]) state.selectedId = id;
    }
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.__hearthTasks = { state, byId, TASKS, renderAll, selectTask };
})();
