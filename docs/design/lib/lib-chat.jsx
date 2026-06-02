/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Floating Project Chat
   A project-level chat that floats on every page. Reuses the float-panel
   chrome from the task-detail float (ember spine, drag handle, dock),
   filled with Hearth thread vocabulary (agent prose, tool blocks, ember
   send + streaming cursor + context meter).

   - Floats bottom-LEFT by default; drag to reposition; snap/dock to the
     left edge (a column abutting the nav rail).
   - One global session. Open/closed, docked, position, and message
     history persist to localStorage so the conversation survives
     navigation between Operations / Tasks / Board / Design / Traces.

   Mounted once by AppShell, so it appears across the whole product.
   ──────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useRef, useEffect, useCallback } = React;

  const LS = {
    open: 'hearth-chat-open',
    pos:  'hearth-chat-pos',
    dock: 'hearth-chat-dock',
    msgs: 'hearth-chat-msgs',
    ctx:  'hearth-chat-ctx',
  };
  const read = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  /* ── Styles — injected once, token-driven so themes follow ── */
  const CSS = `
  /* Launcher (closed state) */
  .hc-launch {
    position: fixed; left: 60px; bottom: 22px; z-index: 9990;
    display: inline-flex; align-items: center; gap: var(--s-2);
    height: 38px; padding: 0 var(--s-4) 0 var(--s-3);
    background: color-mix(in oklch, var(--bg-2) 50%, transparent); color: var(--fg);
    -webkit-backdrop-filter: blur(20px) brightness(1.5) saturate(1.5); backdrop-filter: blur(20px) brightness(1.5) saturate(1.5);
    border: 1px solid color-mix(in oklch, var(--fg) 12%, transparent); border-left: 3px solid var(--accent);
    border-radius: var(--r-full);
    box-shadow: var(--shadow-2), 0 0 18px var(--accent-glow), inset 0 1px 0 color-mix(in oklch, var(--fg) 16%, transparent);
    cursor: pointer; user-select: none;
    transition: all var(--t-base) var(--ease);
  }
  .hc-launch:hover { border-color: var(--accent); box-shadow: var(--shadow-2), 0 0 28px var(--accent-glow); transform: translateY(-1px); }
  .hc-launch .ic { display: inline-flex; color: var(--accent); }
  .hc-launch .lbl { font-family: var(--serif); font-style: italic; font-size: var(--text-15); letter-spacing: -0.01em; }
  .hc-launch .ember { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 7px var(--accent-glow); }

  /* Panel — detached: full height, with margins (stays a floating card) */
  .hc-panel {
    position: fixed; z-index: 9991;
    width: 384px; height: calc(100vh - 76px);
    display: flex; flex-direction: column; overflow: hidden;
    background: linear-gradient(155deg, color-mix(in oklch, var(--bg-3) 34%, transparent), color-mix(in oklch, var(--bg-2) 28%, transparent));
    -webkit-backdrop-filter: blur(30px) brightness(1.5) saturate(1.6); backdrop-filter: blur(30px) brightness(1.5) saturate(1.6);
    border: 1px solid color-mix(in oklch, var(--fg) 12%, transparent); border-left: 3px solid var(--accent);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-3), 0 0 44px rgba(0,0,0,0.34), inset 0 1px 0 color-mix(in oklch, var(--fg) 16%, transparent);
  }
  .hc-panel.dragging { box-shadow: var(--shadow-3), 0 0 64px rgba(0,0,0,0.46), 0 0 26px var(--accent-glow); }
  .hc-panel.dragging * { pointer-events: none; }
  .hc-panel.docked {
    left: 44px !important; top: 38px !important; bottom: 0 !important;
    height: auto !important; width: 372px;
    border-radius: 0; border-left: 1px solid color-mix(in oklch, var(--line) 70%, transparent);
    border-right: 3px solid var(--accent);
    box-shadow: 18px 0 44px rgba(0,0,0,0.34);
  }

  /* Header / drag handle */
  .hc-head {
    flex-shrink: 0; cursor: grab; user-select: none;
    background: color-mix(in oklch, var(--bg-3) 26%, transparent); border-bottom: 1px solid color-mix(in oklch, var(--fg) 8%, transparent);
    padding: var(--s-2) var(--s-2) var(--s-2) var(--s-1h);
  }
  .hc-head:active { cursor: grabbing; }
  .hc-head-top { display: flex; align-items: center; gap: var(--s-1h); }
  .hc-grip { display: flex; flex-direction: column; gap: var(--s-0); padding: var(--s-0); flex-shrink: 0; opacity: 0.4; }
  .hc-grip span { display: block; width: 11px; height: 1.5px; background: var(--fg-mute); border-radius: var(--r-full); }
  .hc-title { font-family: var(--serif); font-size: var(--text-16); letter-spacing: -0.01em; color: var(--fg); flex: 1; line-height: 1; }
  .hc-title .em { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 7px var(--accent-glow); display: inline-block; margin-left: var(--s-1); vertical-align: 2px; }
  .hc-ctrls { display: flex; align-items: center; gap: 1px; flex-shrink: 0; }
  .hc-ctrl { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; color: var(--fg-mute); border: none; background: transparent; border-radius: var(--r-sm); cursor: pointer; transition: all var(--t-fast) var(--ease); }
  .hc-ctrl:hover { background: var(--bg-4); color: var(--fg); }
  .hc-ctrl.dock:hover { background: var(--accent-wash); color: var(--accent); }
  .hc-head-meta { display: flex; align-items: center; gap: var(--s-1h); margin-top: var(--s-1h); margin-left: var(--s-4h); white-space: nowrap; overflow: hidden; }
  .hc-scope { display: inline-flex; align-items: center; gap: var(--s-1); font-family: var(--mono); font-size: var(--text-10); letter-spacing: 0.04em; color: var(--fg-mute); }
  .hc-scope .badge-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 5px color-mix(in oklch, var(--ok) 60%, transparent); }
  .hc-scope-id { font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); padding: 1px var(--s-1h); background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-xs); }
  .hc-sep { color: var(--fg-ghost); font-size: var(--text-10); }

  /* Body / thread */
  .hc-body { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; background: transparent; padding: var(--s-4) var(--s-4) var(--s-3); display: flex; flex-direction: column; gap: var(--s-4); }
  .hc-body::-webkit-scrollbar { width: 5px; }
  .hc-body::-webkit-scrollbar-thumb { background: var(--bg-4); border-radius: var(--r-sm); }
  .hc-body::-webkit-scrollbar-track { background: transparent; }

  .hc-day { align-self: center; font-family: var(--mono); font-size: var(--text-9); letter-spacing: 0.18em; text-transform: uppercase; color: var(--fg-faint); padding: var(--s-0) 0; }

  /* Message turn */
  .hc-turn { display: flex; flex-direction: column; gap: var(--s-1h); max-width: 100%; }
  .hc-turn.user { align-items: flex-end; }
  .hc-turn.assistant { align-items: flex-start; }

  .hc-bubble { max-width: 86%; padding: var(--s-2) var(--s-3); font-size: var(--text-13); line-height: 1.55; border-radius: var(--r-lg); }
  .hc-turn.user .hc-bubble {
    background: var(--accent-wash); color: var(--fg);
    border: 1px solid color-mix(in oklch, var(--accent) 32%, transparent);
    border-bottom-right-radius: var(--r-xs);
  }
  .hc-turn.assistant .hc-speaker {
    font-family: var(--mono); font-size: var(--text-10); letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--fg-mute); display: flex; align-items: center; gap: var(--s-1h); margin-bottom: var(--s-0);
  }
  .hc-turn.assistant .hc-speaker .model { color: var(--fg-faint); font-size: var(--text-9); padding: 1px var(--s-1); border: 1px solid var(--line); border-radius: var(--r-xs); letter-spacing: 0.04em; text-transform: none; }
  .hc-turn.assistant .hc-prose {
    width: 100%; color: var(--fg-soft); font-size: var(--text-13); line-height: 1.6;
    border-left: 2px solid var(--line-strong); padding: 1px 0 1px var(--s-3);
  }
  .hc-prose strong { color: var(--fg); font-weight: 600; }
  .hc-prose code { font-family: var(--mono); font-size: var(--text-12); color: var(--accent); background: var(--accent-wash); padding: 1px var(--s-1); border-radius: var(--r-xs); }
  .hc-cursor { display: inline-block; width: 7px; height: 14px; background: var(--accent); margin-left: var(--s-0); vertical-align: -2px; box-shadow: 0 0 6px var(--accent-glow); animation: hc-blink 1s step-end infinite; }
  @keyframes hc-blink { 50% { opacity: 0; } }

  /* Tool call block */
  .hc-tool { width: 100%; border: 1px solid color-mix(in oklch, var(--step-execute) 28%, var(--line-strong)); border-radius: var(--r-sm); overflow: hidden; }
  .hc-tool-hd { display: flex; align-items: center; gap: var(--s-2); padding: var(--s-1h) var(--s-2); cursor: pointer; background: color-mix(in oklch, var(--step-execute-wash) 28%, var(--bg-2)); transition: background var(--t-fast) var(--ease); }
  .hc-tool-hd:hover { background: color-mix(in oklch, var(--step-execute-wash) 42%, var(--bg-2)); }
  .hc-tool-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--step-execute); flex-shrink: 0; }
  .hc-tool-name { font-family: var(--mono); font-size: var(--text-11); font-weight: 500; color: var(--step-execute-fg); }
  .hc-tool-sum { font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 48%; }
  .hc-tool-chev { color: var(--fg-faint); font-size: var(--text-9); flex-shrink: 0; transition: transform var(--t-fast) var(--ease); }
  .hc-tool.collapsed .hc-tool-chev { transform: rotate(-90deg); }
  .hc-tool-bd { padding: var(--s-2) var(--s-2h); background: var(--bg); border-top: 1px solid var(--line); font-family: var(--mono); font-size: var(--text-11); line-height: 1.55; color: var(--fg-mute); white-space: pre-wrap; max-height: 160px; overflow-y: auto; }
  .hc-tool-bd::-webkit-scrollbar { width: 4px; }
  .hc-tool-bd::-webkit-scrollbar-thumb { background: var(--bg-4); border-radius: var(--r-xs); }
  .hc-tool.collapsed .hc-tool-bd { display: none; }
  .hc-tool.pending { border-color: color-mix(in oklch, var(--accent) 32%, transparent); }
  .hc-tool.pending .hc-tool-hd { background: color-mix(in oklch, var(--accent-wash) 50%, var(--bg-2)); }
  .hc-tool.pending .hc-tool-dot { background: var(--accent); box-shadow: 0 0 5px var(--accent-glow); }
  .hc-tool.pending .hc-tool-name { color: var(--accent); }
  .hc-tool.err { border-color: color-mix(in oklch, var(--err) 38%, transparent); }
  .hc-tool.err .hc-tool-hd { background: color-mix(in oklch, var(--err-wash) 32%, var(--bg-2)); }
  .hc-tool.err .hc-tool-dot { background: var(--err); }
  .hc-tool.err .hc-tool-name { color: var(--err); }
  .hc-spin { width: 9px; height: 9px; border: 1.5px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: hc-spin 0.7s linear infinite; flex-shrink: 0; }
  @keyframes hc-spin { to { transform: rotate(360deg); } }

  /* Footer / composer */
  .hc-foot { flex-shrink: 0; background: color-mix(in oklch, var(--bg-2) 24%, transparent); border-top: 1px solid color-mix(in oklch, var(--fg) 8%, transparent); }
  .hc-ctx { height: 2px; background: color-mix(in oklch, var(--bg) 50%, transparent); position: relative; overflow: hidden; }
  .hc-ctx-fill { height: 100%; transition: width var(--t-slow) var(--ease), background var(--t-slow) var(--ease); }
  .hc-compose { padding: var(--s-2) var(--s-2h) var(--s-2); }
  .hc-input-wrap { display: flex; align-items: flex-end; gap: var(--s-2); background: color-mix(in oklch, var(--bg-1) 60%, transparent); border: 1px solid var(--line-strong); border-radius: var(--r-md); padding: var(--s-1h) var(--s-1h) var(--s-1h) var(--s-2h); transition: all var(--t-fast) var(--ease); }
  .hc-input-wrap:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-wash); }
  .hc-attach { width: 26px; height: 26px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: var(--fg-faint); background: transparent; border: none; border-radius: var(--r-sm); cursor: pointer; transition: color var(--t-fast) var(--ease); margin-bottom: 1px; }
  .hc-attach:hover { color: var(--fg-mute); }
  .hc-text { flex: 1; min-width: 0; resize: none; background: transparent; border: none; outline: none; color: var(--fg); font-family: var(--sans); font-size: var(--text-13); line-height: 1.5; max-height: 96px; padding: var(--s-0) 0; }
  .hc-text::placeholder { color: var(--fg-faint); }
  .hc-send { width: 28px; height: 28px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--accent); color: var(--bg); border: none; border-radius: var(--r-sm); cursor: pointer; transition: all var(--t-fast) var(--ease); }
  .hc-send:hover { background: var(--accent-deep); box-shadow: 0 0 12px var(--accent-glow); }
  .hc-send:disabled { opacity: 0.4; cursor: not-allowed; background: var(--bg-4); color: var(--fg-faint); box-shadow: none; }
  .hc-stop { width: auto; padding: 0 var(--s-2h); gap: var(--s-1); font-family: var(--mono); font-size: var(--text-11); background: transparent; color: var(--err); border: 1px solid color-mix(in oklch, var(--err) 40%, transparent); }
  .hc-stop:hover { background: var(--err-wash); box-shadow: none; }
  .hc-stop .sq { width: 8px; height: 8px; background: currentColor; border-radius: 1px; }
  .hc-foot-meta { display: flex; align-items: center; gap: var(--s-2); padding: 0 var(--s-3) var(--s-2); font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); letter-spacing: 0.04em; }
  .hc-foot-meta .key { padding: 1px var(--s-1); background: var(--bg-3); border: 1px solid var(--line-strong); border-radius: var(--r-xs); color: var(--fg-mute); }
  .hc-foot-meta .ctx-lbl { margin-left: auto; }
  .hc-foot-meta .ctx-lbl b { color: var(--fg-mute); font-weight: 500; }
  `;

  function injectCSS() {
    if (document.getElementById('hearth-chat-styles')) return;
    const s = document.createElement('style');
    s.id = 'hearth-chat-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ── Icons ── */
  const Ic = {
    chat: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>,
    dock: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="18" rx="1" /><path d="M14 8h7M14 12h7M14 16h7" /></svg>,
    undock: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></svg>,
    expand: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>,
    close: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>,
    attach: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>,
    send: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>,
  };

  /* ── Seed conversation (project-level) ── */
  const SEED = [
    { role: 'user', text: 'Which runs need a human before they can finish?' },
    {
      role: 'assistant', speaker: 'sacrum', model: 'orchestrator',
      tools: [{
        name: 'query_runs', summary: 'state: pending_review',
        collapsed: false,
        body: '→ 2 matches\n  03ae9f60  Persist authoring draft   review · 7h 36m\n  bf68e7ac  Score draft quality        review · 41m',
        status: 'done',
      }],
      prose: 'Two runs are holding on a review gate. **Persist authoring draft** has been waiting <code>7h 36m</code> — its acceptance criteria are flagged `human`. **Score draft quality** just entered review 41m ago. Want me to open either one?',
    },
  ];

  /* ── Tool block ── */
  function ToolBlock({ tool, onToggle }) {
    const cls = 'hc-tool' + (tool.status === 'pending' ? ' pending' : tool.status === 'err' ? ' err' : '') + (tool.collapsed ? ' collapsed' : '');
    return (
      <div className={cls}>
        <div className="hc-tool-hd" onClick={onToggle}>
          {tool.status === 'pending' ? <span className="hc-spin" /> : <span className="hc-tool-dot" />}
          <span className="hc-tool-name">{tool.name}</span>
          <span className="hc-tool-sum">{tool.status === 'pending' ? 'running…' : tool.summary}</span>
          {tool.status !== 'pending' ? <span className="hc-tool-chev">▾</span> : null}
        </div>
        {tool.status !== 'pending' ? <div className="hc-tool-bd">{tool.body}</div> : null}
      </div>
    );
  }

  /* minimal inline markdown: **bold** and `code` */
  function renderProse(text) {
    const nodes = [];
    let i = 0, key = 0;
    const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
    let m, last = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) nodes.push(text.slice(last, m.index));
      if (m[1] != null) nodes.push(<strong key={'b' + key++}>{m[1]}</strong>);
      else nodes.push(<code key={'c' + key++}>{m[2]}</code>);
      last = re.lastIndex;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }

  function Turn({ m, streaming, onToggleTool }) {
    if (m.role === 'user') {
      return <div className="hc-turn user"><div className="hc-bubble">{m.text}</div></div>;
    }
    return (
      <div className="hc-turn assistant">
        <div className="hc-speaker">
          {m.streaming ? <span className="hc-spin" /> : <span className="badge-ember" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 6px var(--accent-glow)' }} />}
          {m.speaker || 'sacrum'}
          {m.model ? <span className="model">{m.model}</span> : null}
        </div>
        {(m.tools || []).map((t, ti) => <ToolBlock key={ti} tool={t} onToggle={() => onToggleTool(m.id, ti)} />)}
        {m.prose || m.streaming ? (
          <div className="hc-prose">
            {renderProse(m.prose || '')}
            {m.streaming ? <span className="hc-cursor" /> : null}
          </div>
        ) : null}
      </div>
    );
  }

  /* ── Main ── */
  let UID = 100;
  function ChatFloat() {
    injectCSS();
    const [open, setOpen] = useState(() => read(LS.open, true));
    const [docked, setDocked] = useState(() => read(LS.dock, false));
    const [pos, setPos] = useState(() => read(LS.pos, null)); // {left, top} or null = default
    const [msgs, setMsgs] = useState(() => {
      const saved = read(LS.msgs, null);
      if (saved && saved.length) return saved;
      return SEED.map((s, i) => ({ id: i + 1, ...s }));
    });
    const [draft, setDraft] = useState('');
    const [streaming, setStreaming] = useState(false);
    const [ctx, setCtx] = useState(() => read(LS.ctx, 0.34));
    const [dragging, setDragging] = useState(false);

    const panelRef = useRef(null);
    const bodyRef = useRef(null);
    const textRef = useRef(null);
    const timers = useRef([]);

    useEffect(() => write(LS.open, open), [open]);
    useEffect(() => write(LS.dock, docked), [docked]);
    useEffect(() => write(LS.pos, pos), [pos]);
    useEffect(() => write(LS.ctx, ctx), [ctx]);
    useEffect(() => { write(LS.msgs, msgs); }, [msgs]);

    // autoscroll
    useEffect(() => {
      const b = bodyRef.current;
      if (b) b.scrollTop = b.scrollHeight;
    }, [msgs, open]);

    useEffect(() => () => timers.current.forEach(clearTimeout), []);

    // ── Drag ──
    const drag = useRef(null);
    const onHeadDown = (e) => {
      if (e.target.closest('button')) return;
      if (docked) setDocked(false);
      const p = panelRef.current.getBoundingClientRect();
      drag.current = { sx: e.clientX, sy: e.clientY, sl: p.left, st: p.top };
      setDragging(true);
      e.preventDefault();
    };
    useEffect(() => {
      if (!dragging) return;
      const move = (e) => {
        const d = drag.current; if (!d) return;
        const w = panelRef.current.offsetWidth, h = panelRef.current.offsetHeight;
        let nl = Math.max(0, Math.min(d.sl + (e.clientX - d.sx), window.innerWidth - w));
        let nt = Math.max(38, Math.min(d.st + (e.clientY - d.sy), window.innerHeight - h - 16));
        setPos({ left: nl, top: nt });
      };
      const up = (e) => {
        setDragging(false);
        // snap-dock near left edge
        const p = panelRef.current.getBoundingClientRect();
        if (p.left < 90) setDocked(true);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up, { once: true });
      return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    }, [dragging]);

    const toggleTool = (mid, ti) => {
      setMsgs((cur) => cur.map((m) => {
        if (m.id !== mid) return m;
        const tools = m.tools.map((t, i) => i === ti ? { ...t, collapsed: !t.collapsed } : t);
        return { ...m, tools };
      }));
    };

    // ── Send + simulated streaming reply ──
    const REPLIES = [
      {
        tool: { name: 'search_tasks', summary: 'scope: project · running', body: '→ 3 active runs\n  03ae9f60  durable write fan-out      +41m\n  7c1102de  OpenRouter stream           +9m\n  ae55bd20  tracker mutation            +2m' },
        prose: 'Across **sacrum** there are `3` runs in flight right now. The oldest, **durable write fan-out**, has been executing 41m — nothing failed, it is just deep in a tool loop. Nothing needs you yet.',
      },
      {
        tool: { name: 'read_trace', summary: 'run 03ae9f60 · last turn', body: '→ turn 14 / agent\n  $ run_tests  --filter auth\n  2 failed → retried → green\n  emitted project_activity' },
        prose: 'The latest turn re-ran the auth tests: **2 failed, then retried green**. The run then emitted a `project_activity` event and moved on. Looks healthy — want the full trace?',
      },
    ];
    let replyIdx = useRef(0);

    const stopStream = useCallback(() => {
      timers.current.forEach(clearTimeout); timers.current = [];
      setStreaming(false);
      setMsgs((cur) => cur.map((m) => m.streaming ? { ...m, streaming: false } : m));
    }, []);

    const send = useCallback(() => {
      const text = draft.trim();
      if (!text || streaming) return;
      setDraft('');
      if (textRef.current) textRef.current.style.height = 'auto';
      const uid = ++UID;
      const aid = ++UID;
      const reply = REPLIES[replyIdx.current % REPLIES.length];
      replyIdx.current++;

      setMsgs((cur) => [...cur,
        { id: uid, role: 'user', text },
        { id: aid, role: 'assistant', speaker: 'sacrum', model: 'orchestrator', streaming: true, tools: [{ ...reply.tool, status: 'pending', collapsed: false }], prose: '' },
      ]);
      setStreaming(true);

      // resolve tool
      timers.current.push(setTimeout(() => {
        setMsgs((cur) => cur.map((m) => m.id === aid ? { ...m, tools: m.tools.map((t) => ({ ...t, status: 'done' })) } : m));
        // stream prose
        const full = reply.prose;
        let n = 0;
        const tick = () => {
          n += Math.max(1, Math.round(full.length / 90));
          const slice = full.slice(0, n);
          setMsgs((cur) => cur.map((m) => m.id === aid ? { ...m, prose: slice } : m));
          setCtx((c) => Math.min(0.97, c + 0.006));
          if (n < full.length) { timers.current.push(setTimeout(tick, 26)); }
          else {
            setMsgs((cur) => cur.map((m) => m.id === aid ? { ...m, streaming: false, tools: m.tools.map((t, i) => ({ ...t, collapsed: i === 0 })) } : m));
            setStreaming(false);
            setCtx((c) => Math.min(0.97, c + 0.05));
          }
        };
        timers.current.push(setTimeout(tick, 120));
      }, 760));
    }, [draft, streaming]);

    const onKey = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    };
    const onInput = (e) => {
      setDraft(e.target.value);
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(96, e.target.scrollHeight) + 'px';
    };

    const ctxColor = ctx < 0.6 ? 'var(--ok)' : ctx < 0.85 ? 'var(--warn)' : 'var(--err)';

    if (!open) {
      return (
        <button className="hc-launch" onClick={() => setOpen(true)} title="Open project chat">
          <span className="ic">{Ic.chat}</span>
          <span className="lbl">Ask sacrum</span>
          <span className="ember" />
        </button>
      );
    }

    const style = docked ? {} : (pos ? { left: pos.left, top: pos.top } : { left: 60, bottom: 22 });

    return (
      <div ref={panelRef} className={'hc-panel' + (docked ? ' docked' : '') + (dragging ? ' dragging' : '')} style={style}>
        {/* Header */}
        <div className="hc-head" onMouseDown={onHeadDown}>
          <div className="hc-head-top">
            <span className="hc-grip"><span /><span /><span /></span>
            <span className="hc-title">Project chat<span className="em" /></span>
            <div className="hc-ctrls">
              <button className="hc-ctrl dock" title={docked ? 'Float panel' : 'Dock to left'} onClick={() => setDocked(!docked)}>{docked ? Ic.undock : Ic.dock}</button>
              <button className="hc-ctrl" title="Expand">{Ic.expand}</button>
              <button className="hc-ctrl" title="Close" onClick={() => setOpen(false)}>{Ic.close}</button>
            </div>
          </div>
          <div className="hc-head-meta">
            <span className="hc-scope"><span className="badge-dot" />scoped to</span>
            <span className="hc-scope-id">sacrum</span>
            <span className="hc-sep">·</span>
            <span className="hc-scope">whole project</span>
          </div>
        </div>

        {/* Thread */}
        <div className="hc-body" ref={bodyRef}>
          <div className="hc-day">Today</div>
          {msgs.map((m) => <Turn key={m.id} m={m} streaming={streaming} onToggleTool={toggleTool} />)}
        </div>

        {/* Composer */}
        <div className="hc-foot">
          <div className="hc-ctx"><div className="hc-ctx-fill" style={{ width: (ctx * 100) + '%', background: ctxColor }} /></div>
          <div className="hc-compose">
            <div className="hc-input-wrap">
              <button className="hc-attach" title="Attach context">{Ic.attach}</button>
              <textarea ref={textRef} className="hc-text" rows="1" placeholder="Ask about any run, task, or workflow…" value={draft} onChange={onInput} onKeyDown={onKey} />
              {streaming
                ? <button className="hc-send hc-stop" onClick={stopStream}><span className="sq" />Stop</button>
                : <button className="hc-send" onClick={send} disabled={!draft.trim()} title="Send">{Ic.send}</button>}
            </div>
          </div>
          <div className="hc-foot-meta">
            <span><span className="key">⏎</span> send · <span className="key">⇧⏎</span> newline</span>
            <span className="ctx-lbl">context <b>{Math.round(ctx * 100)}%</b></span>
          </div>
        </div>
      </div>
    );
  }

  Object.assign(window, { ChatFloat });
})();
