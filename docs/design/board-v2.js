/* ──────────────────────────────────────────────────────────────────
   Vertebrae · Hearth — Board v2

   Columns map to runState (not workflow step). Workflow position
   (stepKind) shows as hue on the card's top edge + tiny label.
   ────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  if (!window.HEARTH_DATA) {
    console.error('HEARTH_DATA missing — load tasks-data.js first');
    return;
  }
  const { TASKS, byId, isActiveRun, ancestorIds } = window.HEARTH_DATA;

  // ── State ────────────────────────────────────────────────────
  const state = {
    query: '',
    levelFilter: 'all',
  };

  const COLUMNS = [
    { key: 'queued',  name: 'Queued',  test: (t) => t.runState === 'queued' || t.runState == null,
      empty: 'Nothing queued.' },
    { key: 'running', name: 'Running', test: (t) => t.runState === 'running',
      empty: 'No active runs.' },
    { key: 'waiting', name: 'Waiting', test: (t) => t.runState === 'waiting',
      empty: 'Nothing waiting.' },
    { key: 'done',    name: 'Done',    test: (t) => t.runState === 'completed',
      empty: 'No completed tasks.' },
  ];

  const GLYPHS = ['◈', '◇', '·'];

  // ── Utilities ────────────────────────────────────────────────
  function escape(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function matchesQuery(t) {
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    return t.title.toLowerCase().indexOf(q) !== -1 ||
      t.id.indexOf(q) !== -1 ||
      (t.tags || []).some((x) => x.toLowerCase().indexOf(q) !== -1);
  }
  function matchesLevel(t) {
    if (state.levelFilter === 'all') return true;
    return t.level === Number(state.levelFilter);
  }

  // ── Card pieces ──────────────────────────────────────────────
  function runChipHtml(t) {
    if (!isActiveRun(t.runState)) return '';
    const m = {
      running: { cls: 'running', label: 'Running', spinner: true },
      waiting: { cls: 'waiting', label: 'Waiting' },
      queued:  { cls: 'queued',  label: 'Queued' },
    }[t.runState];
    const runtime = t.runtime ? '<span class="runtime"> · ' + escape(t.runtime) + '</span>' : '';
    const lead = m.spinner ? '<span class="spinner"></span>' : '';
    return '<span class="run-chip ' + m.cls + '">' + lead + escape(m.label) + runtime + '</span>';
  }

  function pipelineHtml(t) {
    if (!t.pipeline || !t.pipeline.length) return '';
    const segs = t.pipeline.map((s) =>
      '<span class="seg kind-' + (s.kind || 'none') + ' s-' + (s.state || 'queued') + '"></span>'
    ).join('');
    return '<div class="pipeline" title="Workflow shape">' + segs + '</div>';
  }

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
    return '<div class="breakdown">' + bits.join(' <span style="color:var(--fg-ghost);">·</span> ') + '</div>';
  }

  function tagsHtml(t) {
    if (!t.tags || !t.tags.length) return '';
    const shown = t.tags.slice(0, 2).map((x) => '<span class="tag">' + escape(x) + '</span>').join(' ');
    const more = t.tags.length > 2 ? '<span style="color:var(--fg-ghost);">+' + (t.tags.length - 2) + '</span>' : '';
    return '<div class="tags">' + shown + ' ' + more + '</div>';
  }

  function idChipHtml(id) {
    return '<span class="id-chip" data-id="' + id + '" title="click to copy">' +
      '<span class="id-text">' + escape(id) + '</span>' +
      '<svg class="copy-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
      '<svg class="ok-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' +
      '</span>';
  }

  function priorityHtml(t) {
    if (!t.priority) return '';
    const sym = t.priority === 'hi' ? '↑' : t.priority === 'md' ? '→' : '↓';
    return '<span class="pri ' + t.priority + '" title="' + t.priority + ' priority">' + sym + '</span>';
  }

  function cardHtml(t) {
    const kindClass = t.stepKind ? ' kind-' + t.stepKind : '';
    const stateClass =
      t.runState === 'running' ? ' running' :
      t.runState === 'completed' ? ' done' : '';
    const glyph = GLYPHS[t.level] || '·';

    const stepTag = t.stepKind
      ? '<span class="step-tag">step · ' + escape(t.stepKind) + '</span>'
      : '';

    return (
      '<div class="card l' + t.level + kindClass + stateClass + '" data-id="' + t.id + '">' +
      '<div class="title-row">' +
      '<span class="glyph">' + glyph + '</span>' +
      '<span class="title">' + escape(t.title) + '</span>' +
      priorityHtml(t) +
      '</div>' +
      (stepTag ? '<div>' + stepTag + '</div>' : '') +
      pipelineHtml(t) +
      breakdownHtml(t) +
      tagsHtml(t) +
      '<div class="foot">' +
      runChipHtml(t) +
      idChipHtml(t.id) +
      '<span class="when">' + escape(t.when || '') + '</span>' +
      '</div>' +
      '</div>'
    );
  }

  // ── Column rendering ─────────────────────────────────────────
  function tasksForColumn(col) {
    return TASKS.filter((t) => col.test(t) && matchesQuery(t) && matchesLevel(t));
  }

  function columnHtml(col) {
    const items = tasksForColumn(col);
    const inner = items.length
      ? items.map(cardHtml).join('') + (col.key === 'queued' ? '<div class="add-stub">＋ New task</div>' : '')
      : '<div class="col-body empty">' + escape(col.empty) + '</div>';

    return (
      '<section class="col ' + col.key + '">' +
      '<header class="col-head">' +
      '<span class="lamp"></span>' +
      '<span class="name">' + escape(col.name) + '</span>' +
      '<span class="count">' + items.length + '</span>' +
      '</header>' +
      (items.length
        ? '<div class="col-body">' + items.map(cardHtml).join('') +
          (col.key === 'queued' ? '<div class="add-stub" data-action="new">＋ New task</div>' : '') +
          '</div>'
        : '<div class="col-body empty">' + escape(col.empty) + '</div>') +
      '</section>'
    );
  }

  function renderActivity() {
    const running = TASKS.filter((t) => t.runState === 'running').length;
    const total = TASKS.length;
    const roots = TASKS.filter((t) => !t.parent).length;
    document.getElementById('activityLive').innerHTML = '<span class="pulse"></span>' + running + ' running';
    document.getElementById('activityTotal').innerHTML = '<b>' + total + '</b> tasks <span style="color:var(--fg-ghost);">·</span> ' + roots + ' roots';
  }

  function renderColumns() {
    document.getElementById('columns').innerHTML = COLUMNS.map(columnHtml).join('');
  }

  function renderAll() { renderActivity(); renderColumns(); }

  // ── Interactivity ────────────────────────────────────────────
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
  function copyId(id, el) {
    function flash() {
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1100);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id).then(flash).catch(() => {
        legacyCopy(id) && flash();
      });
    } else if (legacyCopy(id)) flash();
  }

  function onClick(e) {
    const idChip = e.target.closest('.id-chip');
    if (idChip) {
      e.preventDefault(); e.stopPropagation();
      copyId(idChip.dataset.id, idChip);
      return;
    }
    const card = e.target.closest('.card');
    if (card) {
      // Navigate to list view focused on this task
      window.location.href = 'tasks-v2.html#' + card.dataset.id;
    }
  }

  function onKey(e) {
    const inSearch = document.activeElement === document.getElementById('search');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const s = document.getElementById('search'); s.focus(); s.select();
    } else if (e.key === '/' && !inSearch) {
      e.preventDefault();
      document.getElementById('search').focus();
    } else if (e.key === 'Escape' && inSearch) {
      document.getElementById('search').blur();
      if (state.query) {
        document.getElementById('search').value = '';
        state.query = ''; renderColumns();
      }
    }
  }

  function init() {
    document.getElementById('columns').addEventListener('click', onClick);
    document.getElementById('search').addEventListener('input', (e) => {
      state.query = e.target.value; renderColumns();
    });
    document.getElementById('levelFilter').addEventListener('change', (e) => {
      state.levelFilter = e.target.value; renderColumns();
    });
    document.addEventListener('keydown', onKey);
    renderAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.__hearthBoard = { state, renderAll };
})();
