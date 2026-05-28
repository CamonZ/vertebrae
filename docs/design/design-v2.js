/* Design v2 — workflow list + runtime overlay */
(function () {
  'use strict';

  const WORKFLOWS = [
    { id: 'chat-runner-lifecycle', name: 'Chat Runner Lifecycle',
      shape: ['execute', 'eval', 'route', 'execute', 'execute', 'execute', 'wait', 'execute', 'terminal'],
      steps: 7, runsLive: 1, runs24h: 10, avg: '4m 12s', selected: true },
    { id: 'authoring-verifier-gate', name: 'Authoring · Verifier Gate',
      shape: ['execute', 'eval', 'human', 'execute', 'terminal'],
      steps: 5, runsLive: 0, runs24h: 14, avg: '1m 38s' },
    { id: 'work-breakdown-draft', name: 'Work Breakdown · Draft to Tasks',
      shape: ['execute', 'eval', 'route', 'execute', 'execute', 'terminal'],
      steps: 6, runsLive: 0, runs24h: 4, avg: '2m 04s' },
    { id: 'tracker-mutation', name: 'Tracker · Mutation Pipeline',
      shape: ['execute', 'execute', 'eval', 'execute', 'terminal'],
      steps: 5, runsLive: 0, runs24h: 31, avg: '0m 22s' },
    { id: 'openrouter-stream', name: 'OpenRouter · Streaming Inference',
      shape: ['execute', 'execute', 'execute', 'terminal'],
      steps: 4, runsLive: 0, runs24h: 88, avg: '11s' },
    { id: 'investigation-resume', name: 'Investigation · Wait & Resume',
      shape: ['execute', 'wait', 'eval', 'human', 'execute', 'terminal'],
      steps: 6, runsLive: 0, runs24h: 2, avg: '38m 11s' },
    { id: 'human-review', name: 'Human Review · Approval Loop',
      shape: ['execute', 'human', 'route', 'terminal'],
      steps: 4, runsLive: 0, runs24h: 7, avg: '12m 09s' },
    { id: 'session-rehydrate', name: 'Session · Rehydration',
      shape: ['execute', 'execute', 'eval', 'execute', 'terminal'],
      steps: 5, runsLive: 0, runs24h: 16, avg: '0m 41s' },
    { id: 'planning-investigate', name: 'Planning · Investigation Run',
      shape: ['eval', 'route', 'execute', 'execute', 'eval', 'terminal'],
      steps: 6, runsLive: 0, runs24h: 6, avg: '8m 22s' },
    { id: 'artifact-attach', name: 'Artifact · Attach & Project',
      shape: ['execute', 'eval', 'execute', 'terminal'],
      steps: 4, runsLive: 0, runs24h: 22, avg: '0m 19s' },
  ];

  function escape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderList(filter) {
    const list = document.getElementById('wfList');
    const q = (filter || '').toLowerCase();
    const items = WORKFLOWS.filter(w => !q || w.name.toLowerCase().indexOf(q) !== -1);
    list.innerHTML = items.map(w => {
      const segs = w.shape.map(k => '<span class="seg kind-' + k + '"></span>').join('');
      const live = w.runsLive
        ? '<span class="runs-live"><span class="pulse"></span>' + w.runsLive + ' running</span><span class="sep">·</span>'
        : '';
      return (
        '<div class="wf-item' + (w.selected ? ' sel' : '') + '" data-id="' + w.id + '">' +
        '<div class="wf-title">' + escape(w.name) + '</div>' +
        '<div class="wf-shape">' + segs + '</div>' +
        '<div class="wf-meta">' +
        live +
        '<span>' + w.steps + ' steps</span>' +
        '<span class="sep">·</span>' +
        '<span>' + w.runs24h + ' / 24h</span>' +
        '<span class="sep">·</span>' +
        '<span>avg ' + w.avg + '</span>' +
        '</div>' +
        '</div>'
      );
    }).join('');
  }

  // ID chip copy (capture phase, works anywhere)
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

  function init() {
    window.__designInit = true;
    renderList('');

    // Center canvas on the active node — wait for layout
    function centerOnActive() {
      const canvas = document.getElementById('canvas');
      const activeNode = document.querySelector('.node.active');
      if (canvas && activeNode && activeNode.offsetLeft > 0) {
        const targetLeft = activeNode.offsetLeft - (canvas.clientWidth - activeNode.offsetWidth) / 2;
        canvas.scrollLeft = Math.max(0, targetLeft);
      }
    }
    window.__centerOnActive = centerOnActive;
    requestAnimationFrame(centerOnActive);
    setTimeout(centerOnActive, 100);
    setTimeout(centerOnActive, 400);

    document.addEventListener('click', (e) => {
      const chip = e.target.closest('.id-chip');
      if (chip) {
        e.preventDefault(); e.stopPropagation();
        copyId(chip.dataset.id, chip);
        return;
      }
    }, true);

    document.getElementById('wfList').addEventListener('click', (e) => {
      const it = e.target.closest('.wf-item'); if (!it) return;
      document.querySelectorAll('.wf-item').forEach(x => x.classList.remove('sel'));
      it.classList.add('sel');
      // In a real app, would re-render canvas. Here we just animate the selection.
    });

    document.getElementById('wfSearch').addEventListener('input', (e) => {
      renderList(e.target.value);
    });

    // Overlay toggle
    document.querySelectorAll('.overlay-toggle button').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.overlay-toggle button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const mode = b.dataset.overlay;
        const canvas = document.getElementById('canvasInner');
        canvas.dataset.overlay = mode;
        // Show / hide live edges & active state
        document.querySelectorAll('.edges path.live').forEach(p => {
          p.style.display = (mode === 'off') ? 'none' : '';
        });
        document.querySelectorAll('.node.active').forEach(n => {
          if (mode === 'off') {
            n.classList.add('active-suspend');
            n.classList.remove('active');
          }
        });
        if (mode !== 'off') {
          document.querySelectorAll('.node.active-suspend').forEach(n => {
            n.classList.remove('active-suspend');
            n.classList.add('active');
          });
        }
      });
    });

    // Inspector toggle
    const inspector = document.getElementById('inspector');
    document.getElementById('inspectorToggle').addEventListener('click', () => {
      inspector.classList.toggle('closed');
      // Re-center on active after width changes
      setTimeout(window.__centerOnActive, 250);
    });

    // Step click → highlight + open inspector
    document.querySelectorAll('.node').forEach(n => {
      n.addEventListener('click', () => {
        document.querySelectorAll('.node.sel').forEach(x => x.classList.remove('sel'));
        n.classList.add('sel');
        if (inspector.classList.contains('closed')) {
          inspector.classList.remove('closed');
          setTimeout(window.__centerOnActive, 250);
        }
      });
    });

    // Run card click — selects on bottom strip
    document.querySelectorAll('.run-card').forEach(rc => {
      rc.addEventListener('click', () => {
        document.querySelectorAll('.run-card').forEach(x => x.classList.remove('sel'));
        rc.classList.add('sel');
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
