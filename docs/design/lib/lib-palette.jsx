/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Command palette (⌘K)
   A global, cross-type floating surface. Invoked with ⌘K / Ctrl+K from
   any page. Searches ACROSS types — workflows, tasks, runs — and also
   runs commands & navigation. This is the "take me to / do X" surface,
   complementary to the in-pane "/" filter which only narrows one list.

   Mounted once by AppShell. Controlled by props:
     open        — overlay visible
     onClose()   — dismiss
     onNavigate(item) — a result/command was chosen
   ──────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useEffect, useRef, useMemo } = React;

  const CSS = `
  .cp-scrim {
    position: fixed; inset: 0; z-index: 9997;
    background: color-mix(in oklch, var(--bg) 58%, transparent);
    -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
    display: flex; align-items: flex-start; justify-content: center;
    padding: 12vh var(--s-5) var(--s-5);
  }
  .cp {
    width: 600px; max-width: 100%; max-height: 64vh;
    display: flex; flex-direction: column; overflow: hidden;
    background: linear-gradient(160deg, color-mix(in oklch, var(--bg-3) 40%, transparent), color-mix(in oklch, var(--bg-2) 34%, transparent));
    -webkit-backdrop-filter: blur(30px) brightness(1.5) saturate(1.6); backdrop-filter: blur(30px) brightness(1.5) saturate(1.6);
    border: 1px solid color-mix(in oklch, var(--fg) 12%, transparent);
    border-top: 3px solid var(--accent);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-3), 0 0 70px rgba(0,0,0,0.5), inset 0 1px 0 color-mix(in oklch, var(--fg) 16%, transparent);
    animation: cp-in var(--t-base) var(--ease);
    transform-origin: top center;
  }
  @keyframes cp-in { from { transform: translateY(-10px) scale(0.985); } to { transform: none; } }

  /* Search header */
  .cp-search { display: flex; align-items: center; gap: var(--s-2h); padding: var(--s-3h) var(--s-4h); border-bottom: 1px solid var(--line); }
  .cp-search > .mag { color: var(--accent); flex-shrink: 0; display: flex; }
  .cp-search input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: var(--fg); font-family: var(--sans); font-size: var(--text-18); letter-spacing: -0.01em; }
  .cp-search input::placeholder { color: var(--fg-faint); }
  .cp-search .esc { flex-shrink: 0; font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); border: 1px solid var(--line-strong); background: var(--bg); border-radius: var(--r-xs); padding: var(--s-0) var(--s-1h); }

  /* Results */
  .cp-body { overflow-y: auto; padding: var(--s-1h); }
  .cp-body::-webkit-scrollbar { width: 7px; }
  .cp-body::-webkit-scrollbar-thumb { background: var(--bg-4); border-radius: var(--r-md); }

  .cp-group { padding: 0 0 var(--s-1); }
  .cp-group-lbl { font-family: var(--mono); font-size: var(--text-10); letter-spacing: 0.18em; text-transform: uppercase; color: var(--fg-faint); padding: var(--s-2) var(--s-2h) var(--s-1); display: flex; align-items: center; gap: var(--s-2); }
  .cp-group-lbl .ct { color: var(--fg-ghost); }

  .cp-row { display: grid; grid-template-columns: 26px 1fr auto; gap: var(--s-2h); align-items: center; padding: var(--s-2) var(--s-2h); border-radius: var(--r-sm); cursor: pointer; border: 1px solid transparent; }
  .cp-row .ic { width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; border-radius: var(--r-sm); background: var(--bg-1); border: 1px solid var(--line-strong); color: var(--fg-mute); }
  .cp-row.sel { background: var(--accent-wash); border-color: color-mix(in oklch, var(--accent) 30%, transparent); }
  .cp-row.sel .ic { background: var(--accent); border-color: var(--accent); color: var(--bg); box-shadow: 0 0 11px var(--accent-glow); }
  .cp-main { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .cp-title { font-size: var(--text-14); color: var(--fg); letter-spacing: -0.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cp-title b { color: var(--accent); font-weight: 600; }
  .cp-sub { font-family: var(--mono); font-size: var(--text-11); color: var(--fg-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cp-right { display: flex; align-items: center; gap: var(--s-2); flex-shrink: 0; }
  .cp-kindchip { font-family: var(--mono); font-size: var(--text-9); letter-spacing: 0.04em; padding: var(--s-0) var(--s-1h); border-radius: var(--r-full); white-space: nowrap; }
  .cp-state { font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); display: inline-flex; align-items: center; gap: var(--s-1); }
  .cp-state .pulse { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 5px var(--accent-glow); animation: app-pulse 1.6s ease-in-out infinite; }
  .cp-go { color: var(--fg-faint); display: flex; opacity: 0; }
  .cp-row.sel .cp-go { opacity: 1; color: var(--accent); }

  .cp-empty { padding: var(--s-8) var(--s-4) var(--s-10); text-align: center; }
  .cp-empty .big { font-family: var(--serif); font-style: italic; font-size: var(--text-18); color: var(--fg-mute); }
  .cp-empty .sm { font-family: var(--mono); font-size: var(--text-11); color: var(--fg-faint); margin-top: var(--s-1h); }

  /* Footer legend */
  .cp-foot { border-top: 1px solid var(--line); padding: var(--s-2) var(--s-3h); display: flex; align-items: center; gap: var(--s-4); background: color-mix(in oklch, var(--bg-1) 40%, transparent); }
  .cp-foot .leg { font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); display: inline-flex; align-items: center; gap: var(--s-1h); }
  .cp-foot .leg kbd { font-family: var(--mono); font-size: var(--text-10); padding: 1px var(--s-1); background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: var(--r-xs); color: var(--fg-mute); }
  .cp-foot .scoped { margin-left: auto; font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); }
  .cp-foot .scoped b { color: var(--fg-mute); font-weight: 500; }
  `;

  function injectCSS() {
    if (document.getElementById('hearth-palette-styles')) return;
    const s = document.createElement('style');
    s.id = 'hearth-palette-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  const I = {
    mag: <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>,
    go: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" /></svg>,
    wf: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="6" r="2.4" /><circle cx="19" cy="6" r="2.4" /><circle cx="12" cy="18" r="2.4" /><path d="M7.4 6H17M6 8.4 10.5 15.6M18 8.4 13.5 15.6" /></svg>,
    task: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 12l3 3 5-6" /></svg>,
    run: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="6 4 20 12 6 20 6 4" /></svg>,
    nav: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6" /></svg>,
    cmd: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" /></svg>,
  };

  // ── Searchable index (cross-type) ──
  const INDEX = [
    // workflows
    { type: 'workflow', icon: I.wf, title: 'Chat Runner Lifecycle', sub: '7 steps · 1 running · avg 4m 12s', state: 'live' },
    { type: 'workflow', icon: I.wf, title: 'Authoring · Verifier Gate', sub: '5 steps · 14 runs / 24h', state: 'idle' },
    { type: 'workflow', icon: I.wf, title: 'Tracker · Mutation Pipeline', sub: '5 steps · 31 runs / 24h', state: 'idle' },
    { type: 'workflow', icon: I.wf, title: 'OpenRouter · Streaming Inference', sub: '4 steps · 88 runs / 24h', state: 'idle' },
    // tasks
    { type: 'task', icon: I.task, title: 'Persist authoring draft to durable store', sub: '#03ae9f60 · review · 7h 36m', kind: 'review' },
    { type: 'task', icon: I.task, title: 'Stream live chat — turn 184', sub: '#7c1102de · running · +9m', kind: 'execute' },
    { type: 'task', icon: I.task, title: 'Expose tracker operations — chat turn', sub: '#ae55bd20 · done · 38m', kind: 'done' },
    { type: 'task', icon: I.task, title: 'Score draft quality — verifier pass', sub: '#bf68e7ac · review · 41m', kind: 'review' },
    // runs
    { type: 'run', icon: I.run, title: 'Emit chat runner activity events', sub: 'run #40628099 · waiting at step 5 · 7h 36m', state: 'live' },
    { type: 'run', icon: I.run, title: 'Drive authoring intents — verifier pass', sub: 'run #40628042 · done · 11m', state: 'idle' },
    // navigation
    { type: 'nav', icon: I.nav, title: 'Go to Operations', sub: '⌘1', cmd: true },
    { type: 'nav', icon: I.nav, title: 'Go to Tasks', sub: '⌘2', cmd: true },
    { type: 'nav', icon: I.nav, title: 'Go to Board', sub: '⌘3', cmd: true },
    { type: 'nav', icon: I.nav, title: 'Go to Design', sub: '⌘4', cmd: true },
    { type: 'nav', icon: I.nav, title: 'Go to Traces', sub: '⌘5', cmd: true },
    // commands
    { type: 'command', icon: I.cmd, title: 'Toggle dark / light theme', sub: '⌘⇧D', cmd: true },
    { type: 'command', icon: I.cmd, title: 'Open project chat', sub: 'ask sacrum', cmd: true },
    { type: 'command', icon: I.cmd, title: 'Switch project…', sub: 'open switcher', cmd: true },
    { type: 'command', icon: I.cmd, title: 'New workflow', sub: 'create definition', cmd: true },
  ];

  const GROUPS = [
    { type: 'nav', label: 'Navigate' },
    { type: 'command', label: 'Commands' },
    { type: 'workflow', label: 'Workflows' },
    { type: 'task', label: 'Tasks' },
    { type: 'run', label: 'Runs' },
  ];

  const KIND_COLOR = {
    execute: ['var(--step-execute-fg)', 'var(--step-execute-wash)', 'var(--step-execute)'],
    review: ['var(--warn)', 'var(--warn-wash)', 'var(--warn)'],
    done: ['var(--ok)', 'var(--ok-wash)', 'var(--ok)'],
  };

  function highlight(text, q) {
    if (!q) return text;
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i === -1) return text;
    return <>{text.slice(0, i)}<b>{text.slice(i, i + q.length)}</b>{text.slice(i + q.length)}</>;
  }

  function CommandPalette({ open, onClose, onNavigate }) {
    injectCSS();
    const [q, setQ] = useState('');
    const [sel, setSel] = useState(0);
    const bodyRef = useRef(null);
    const inputRef = useRef(null);

    useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 30); } }, [open]);

    // filtered + ordered flat list (grouped)
    const { groups, flat } = useMemo(() => {
      const ql = q.trim().toLowerCase();
      const match = (it) => !ql || it.title.toLowerCase().includes(ql) || (it.sub || '').toLowerCase().includes(ql);
      const groups = GROUPS.map((g) => ({ ...g, items: INDEX.filter((it) => it.type === g.type && match(it)) })).filter((g) => g.items.length);
      const flat = [];
      groups.forEach((g) => g.items.forEach((it) => flat.push(it)));
      return { groups, flat };
    }, [q]);

    useEffect(() => { setSel(0); }, [q]);

    useEffect(() => {
      if (!open) return;
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(flat.length - 1, s + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); if (flat[sel]) { onNavigate && onNavigate(flat[sel]); onClose(); } }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [open, flat, sel, onClose, onNavigate]);

    // keep selected row visible
    useEffect(() => {
      const b = bodyRef.current; if (!b) return;
      const row = b.querySelector('.cp-row.sel');
      if (row) {
        const rt = row.offsetTop, rb = rt + row.offsetHeight;
        if (rt < b.scrollTop) b.scrollTop = rt - 8;
        else if (rb > b.scrollTop + b.clientHeight) b.scrollTop = rb - b.clientHeight + 8;
      }
    }, [sel]);

    if (!open) return null;

    let idx = -1;
    return (
      <div className="cp-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="cp" role="dialog" aria-modal="true" aria-label="Command palette">
          <div className="cp-search">
            <span className="mag">{I.mag}</span>
            <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search anything, or jump to…" />
            <span className="esc">esc</span>
          </div>

          <div className="cp-body" ref={bodyRef}>
            {flat.length === 0 ? (
              <div className="cp-empty">
                <div className="big">Nothing matches “{q}”.</div>
                <div className="sm">Try a task id, a workflow name, or a command.</div>
              </div>
            ) : groups.map((g) => (
              <div className="cp-group" key={g.type}>
                <div className="cp-group-lbl">{g.label}<span className="ct">{g.items.length}</span></div>
                {g.items.map((it) => {
                  idx++; const myIdx = idx;
                  const seld = myIdx === sel;
                  const kc = it.kind && KIND_COLOR[it.kind];
                  return (
                    <div key={it.title} className={'cp-row' + (seld ? ' sel' : '')}
                      onMouseEnter={() => setSel(myIdx)}
                      onClick={() => { onNavigate && onNavigate(it); onClose(); }}>
                      <span className="ic">{it.icon}</span>
                      <span className="cp-main">
                        <span className="cp-title">{highlight(it.title, q)}</span>
                        <span className="cp-sub">{it.sub}</span>
                      </span>
                      <span className="cp-right">
                        {kc ? <span className="cp-kindchip" style={{ color: kc[0], background: kc[1], border: '1px solid color-mix(in oklch, ' + kc[2] + ' 30%, transparent)' }}>{it.kind}</span> : null}
                        {it.state === 'live' ? <span className="cp-state"><span className="pulse" />live</span> : null}
                        <span className="cp-go">{I.go}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="cp-foot">
            <span className="leg"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
            <span className="leg"><kbd>↵</kbd> open</span>
            <span className="leg"><kbd>esc</kbd> close</span>
            <span className="scoped">searching <b>all of sacrum</b></span>
          </div>
        </div>
      </div>
    );
  }

  Object.assign(window, { CommandPalette });
})();
