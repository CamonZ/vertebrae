/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Appearance (theme) control
   Tri-state: System · Light · Dark. Lives in the rail footer (the
   conventional preferences slot), opens a small popover with a
   sun / monitor / moon segmented selector. Also driven by ⌘⇧D and the
   ⌘K palette. Resolves "System" against prefers-color-scheme and keeps
   it live. Persists to localStorage('hearth-theme').

   Replaces the old disconnected floating binary toggle.
   ──────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useEffect, useRef } = React;

  const KEY = 'hearth-theme';            // 'system' | 'light' | 'dark'
  const ORDER = ['system', 'light', 'dark'];

  // ── Theme manager (singleton, shared) ──
  const mgr = (function () {
    const listeners = new Set();
    let mql = null;
    const getPref = () => { try { return localStorage.getItem(KEY) || 'dark'; } catch (e) { return 'dark'; } };
    const sysIsLight = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    const resolve = (pref) => pref === 'system' ? (sysIsLight() ? 'light' : 'dark') : pref;
    function apply() {
      const resolved = resolve(getPref());
      document.documentElement.classList.toggle('theme-light', resolved === 'light');
    }
    function watch() {
      if (mql || !window.matchMedia) return;
      mql = window.matchMedia('(prefers-color-scheme: light)');
      const onChange = () => { if (getPref() === 'system') { apply(); listeners.forEach((l) => l()); } };
      try { mql.addEventListener('change', onChange); } catch (e) { mql.addListener(onChange); }
    }
    function set(pref) {
      try { localStorage.setItem(KEY, pref); } catch (e) {}
      apply();
      listeners.forEach((l) => l());
    }
    function cycle() {
      const i = ORDER.indexOf(getPref());
      set(ORDER[(i + 1) % ORDER.length]);
    }
    watch(); apply();
    return {
      getPref, resolve, set, cycle,
      resolved: () => resolve(getPref()),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    };
  })();

  const CSS = `
  .app-rail .appearance { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; color: var(--fg-faint); background: transparent; border: none; border-radius: var(--r-sm); cursor: pointer; transition: all var(--t-fast) var(--ease); }
  .app-rail .appearance:hover { background: var(--bg-1); color: var(--fg); }
  .app-rail .appearance[aria-expanded="true"] { background: var(--accent-wash); color: var(--accent); }

  .ap-scrim { position: fixed; inset: 0; z-index: 9994; background: transparent; }
  .ap-pop {
    position: fixed; left: 52px; bottom: 16px; z-index: 9995;
    width: 210px;
    background: var(--bg-2);
    border: 1px solid var(--line-strong); border-left: 3px solid var(--accent);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-3), 0 0 30px rgba(0,0,0,0.34);
    padding: var(--s-2); animation: ap-in var(--t-base) var(--ease);
    transform-origin: bottom left;
  }
  @keyframes ap-in { from { transform: translateY(6px) scale(0.98); } to { transform: none; } }
  .ap-pop::before {
    content: ''; position: absolute; left: -7px; bottom: 18px;
    width: 12px; height: 12px; background: var(--bg-2);
    border-left: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-strong);
    transform: rotate(45deg);
  }
  .ap-lbl { font-family: var(--mono); font-size: var(--text-10); letter-spacing: 0.18em; text-transform: uppercase; color: var(--fg-faint); padding: var(--s-0) var(--s-1) var(--s-2); }
  .ap-seg { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: var(--s-1); background: var(--bg-1); border: 1px solid var(--line-strong); border-radius: var(--r-md); padding: var(--s-0); }
  .ap-opt { display: flex; flex-direction: column; align-items: center; gap: var(--s-1); padding: var(--s-2) var(--s-1) var(--s-1h); border-radius: var(--r-sm); cursor: pointer; color: var(--fg-mute); background: transparent; border: 1px solid transparent; transition: all var(--t-fast) var(--ease); }
  .ap-opt:hover { background: var(--bg-2); color: var(--fg-soft); }
  .ap-opt.on { background: var(--accent-wash); border-color: color-mix(in oklch, var(--accent) 30%, transparent); color: var(--accent); }
  .ap-opt .gl { display: flex; }
  .ap-opt .nm { font-family: var(--mono); font-size: var(--text-10); letter-spacing: 0.04em; }
  .ap-foot { display: flex; align-items: center; gap: var(--s-1h); padding: var(--s-2) var(--s-1) var(--s-0); font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); }
  .ap-foot .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 5px color-mix(in oklch, var(--ok) 60%, transparent); }
  .ap-foot .key { margin-left: auto; }
  .ap-foot .key kbd { font-family: var(--mono); font-size: var(--text-9); padding: 1px var(--s-1); background: var(--bg-3); border: 1px solid var(--line-strong); border-radius: var(--r-xs); color: var(--fg-mute); }
  `;

  function injectCSS() {
    if (document.getElementById('hearth-theme-styles')) return;
    const s = document.createElement('style');
    s.id = 'hearth-theme-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  const GLYPH = {
    system: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" /></svg>,
    light: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4.2" /><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" /></svg>,
    dark: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" /></svg>,
  };
  const LABEL = { system: 'System', light: 'Light', dark: 'Dark' };

  function ThemeControl() {
    injectCSS();
    const [open, setOpen] = useState(false);
    const [, force] = useState(0);
    useEffect(() => mgr.subscribe(() => force((n) => n + 1)), []);
    useEffect(() => {
      if (!open) return;
      const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    const pref = mgr.getPref();
    const resolved = mgr.resolved();

    return (
      <>
        <button className="appearance" aria-expanded={open} title="Appearance" aria-label="Appearance"
          onClick={() => setOpen((o) => !o)}>
          {GLYPH[pref]}
        </button>
        {open ? (
          <>
            <div className="ap-scrim" onClick={() => setOpen(false)} />
            <div className="ap-pop" role="menu">
              <div className="ap-lbl">Appearance</div>
              <div className="ap-seg">
                {ORDER.map((id) => (
                  <button key={id} className={'ap-opt' + (pref === id ? ' on' : '')}
                    onClick={() => mgr.set(id)} role="menuitemradio" aria-checked={pref === id}>
                    <span className="gl">{GLYPH[id]}</span>
                    <span className="nm">{LABEL[id]}</span>
                  </button>
                ))}
              </div>
              <div className="ap-foot">
                <span className="dot" />
                {pref === 'system' ? <span>following OS · {resolved}</span> : <span>{LABEL[pref]} mode</span>}
                <span className="key"><kbd>⌘⇧D</kbd></span>
              </div>
            </div>
          </>
        ) : null}
      </>
    );
  }

  Object.assign(window, { ThemeControl, __hearthTheme: mgr });
})();
