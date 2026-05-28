/* Traces v2 — list rail + interactive events */
(function () {
  'use strict';

  // Tasks tree — minimal copy of the parent ticket + its 6 child tasks
  const TASKS = [
    { id: 'fe0a3c08', title: 'Explore backend chat sessions and app-owned workflows', level: 0 },
    { id: '40628099', title: 'Emit chat runner activity events and replace single-shot live chat runner lifecycle', level: 1, selected: true },
    { id: '80e1a7b6', title: 'Define client-safe chat runner activity event builders', level: 2 },
    { id: 'a904a91e', title: 'Route user turns through the session-owned chat runner', level: 2 },
    { id: '23df40d5', title: 'Keep chat session runners alive between turns', level: 2 },
    { id: 'c794b783', title: 'Hydrate chat runner state and resume pending work', level: 2 },
    { id: 'c0a5b5e3', title: 'Project runner activity through chat public event surfaces', level: 2 },
    { id: '8156c4fb', title: 'Add end-to-end tests for activity, multi-turn ingress, and restart recovery', level: 2 },
  ];

  const RUNS = [
    { id: '43abee9d', when: '01:13 AM', state: 'waiting', runtime: '7h 36m', selected: true },
    { id: '6b2f5482', when: '01:05 AM', state: 'failed', reason: 'tool timeout' },
  ];

  function escape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function idChip(id) {
    return '<span class="id-chip" data-id="' + id + '" title="click to copy">' +
      '<span class="id-text">' + escape(id) + '</span>' +
      '<svg class="copy-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="1"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
      '<svg class="ok-mark" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' +
      '</span>';
  }

  function runChipHtml(state, runtime) {
    const labels = {
      running: 'Running', waiting: 'Waiting', queued: 'Queued',
      failed: 'Failed', completed: 'Completed'
    };
    const spinner = (state === 'running') ? '<span class="spinner"></span>' : '';
    return '<span class="run-chip ' + state + '">' + spinner +
      escape(labels[state] || state) +
      (runtime ? '<span class="runtime"> · ' + escape(runtime) + '</span>' : '') +
      '</span>';
  }

  function renderTasks() {
    const list = document.getElementById('tasksList');
    list.innerHTML = TASKS.map(t => {
      const glyph = t.level === 0 ? '◇' : t.level === 1 ? '◇' : '·';
      const cls = 'task-row l' + t.level + (t.selected ? ' sel' : '');
      return (
        '<div class="' + cls + '" data-id="' + t.id + '">' +
        '<span class="glyph">' + glyph + '</span>' +
        '<span class="ttext">' + escape(t.title) + '</span>' +
        idChip(t.id) +
        '</div>'
      );
    }).join('');
  }

  function renderRuns() {
    const list = document.getElementById('runsList');
    list.innerHTML = RUNS.map(r => {
      const cls = 'run-card' + (r.selected ? ' sel' : '');
      return (
        '<div class="' + cls + '" data-id="' + r.id + '">' +
        '<div class="head">' +
        runChipHtml(r.state, r.runtime) +
        idChip(r.id) +
        '</div>' +
        '<div class="when">started ' + escape(r.when) +
        (r.reason ? ' <span style="color:var(--fg-faint);">·</span> <span style="color:var(--err);">' + escape(r.reason) + '</span>' : '') +
        '</div>' +
        '</div>'
      );
    }).join('');
  }

  // ── Clipboard ──
  function legacyCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }
  function copyId(id, el) {
    const flash = () => {
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 1100);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(id).then(flash).catch(() => { legacyCopy(id) && flash(); });
    } else if (legacyCopy(id)) flash();
  }

  // ── Interactions ──
  function init() {
    renderTasks();
    renderRuns();

    // ID chip copy (capture)
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('.id-chip');
      if (chip) {
        e.preventDefault(); e.stopPropagation();
        copyId(chip.dataset.id, chip);
      }
    }, true);

    // Run card select
    document.getElementById('runsList').addEventListener('click', (e) => {
      const c = e.target.closest('.run-card'); if (!c) return;
      document.querySelectorAll('#runsList .run-card').forEach(x => x.classList.remove('sel'));
      c.classList.add('sel');
    });

    // Task row select
    document.getElementById('tasksList').addEventListener('click', (e) => {
      const r = e.target.closest('.task-row'); if (!r) return;
      document.querySelectorAll('#tasksList .task-row').forEach(x => x.classList.remove('sel'));
      r.classList.add('sel');
    });

    // Scope filter
    document.querySelectorAll('.scope').forEach(s => {
      s.addEventListener('click', () => {
        document.querySelectorAll('.scope').forEach(x => x.classList.remove('active'));
        s.classList.add('active');
      });
    });

    // Auto-scroll toggle
    const auto = document.getElementById('autoScroll');
    if (auto) {
      auto.addEventListener('click', () => auto.classList.toggle('on'));
    }

    // Event click — select on stream + jump play-head on strip
    document.getElementById('stream').addEventListener('click', (e) => {
      const ev = e.target.closest('.event'); if (!ev) return;
      document.querySelectorAll('.event.sel').forEach(x => x.classList.remove('sel'));
      ev.classList.add('sel');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
