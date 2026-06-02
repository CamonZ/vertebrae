/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Controls + Shell
   Button · IconButton · SearchBar · ViewTabs · OverlayToggle
   AutoScrollSwitch · ScopeChip · ScopeRow · LevelSelect · TopBar · SideRail
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState } = React;

  // ── Icons (shared) ──────────────────────────────────────────
  const Icons = {
    list: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>,
    board: <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="18" rx="1" /><rect x="14" y="3" width="7" height="11" rx="1" /></svg>,
    design: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="6" r="3" /><circle cx="19" cy="6" r="3" /><circle cx="12" cy="18" r="3" /><path d="m7 8 4 8M17 8l-4 8" /></svg>,
    traces: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h4l3-9 4 18 3-9h4" /></svg>,
    detach: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>,
    play: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>,
    more: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></svg>,
    close: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>,
    search: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>,
  };

  // ── Button ──────────────────────────────────────────────────
  // variant: primary | ghost ; size: sm
  function Button({ variant, size, children, onClick }) {
    const cls = 'btn' + (variant === 'ghost' ? ' ghost' : '') + (size === 'sm' ? ' sm' : '');
    return <button className={cls} onClick={onClick}>{children}</button>;
  }

  // ── IconButton ──────────────────────────────────────────────
  function IconButton({ icon, title, sm, onClick }) {
    return (
      <button className={'icon-btn' + (sm ? ' sm' : '')} title={title} onClick={onClick}>
        {typeof icon === 'string' ? Icons[icon] : icon}
      </button>
    );
  }

  // ── SearchBar ───────────────────────────────────────────────
  function SearchBar({ placeholder = 'Search…', hint = '/', value, defaultValue, onChange, inputRef, onKeyDown, autoFocus }) {
    const [internal, setInternal] = useState(defaultValue || '');
    const controlled = value != null;
    const val = controlled ? value : internal;
    return (
      <div className="search-bar">
        {Icons.search}
        <input ref={inputRef} placeholder={placeholder} value={val} autoFocus={autoFocus}
          onChange={e => { if (!controlled) setInternal(e.target.value); onChange && onChange(e.target.value); }}
          onKeyDown={onKeyDown} />
        {hint ? <span className="hint"><kbd>{hint}</kbd></span> : null}
      </div>
    );
  }

  // ── ViewTabs ────────────────────────────────────────────────
  // tabs: [{ id, label, icon }] ; controlled or uncontrolled
  function ViewTabs({ tabs, value, defaultValue, onChange }) {
    const [internal, setInternal] = useState(defaultValue || tabs[0].id);
    const active = value != null ? value : internal;
    return (
      <div className="view-tabs">
        {tabs.map(t => (
          <button key={t.id} className={t.id === active ? 'active' : ''}
            onClick={() => { setInternal(t.id); onChange && onChange(t.id); }}>
            {t.icon ? (typeof t.icon === 'string' ? Icons[t.icon] : t.icon) : null}{t.label}
          </button>
        ))}
      </div>
    );
  }

  // ── OverlayToggle ───────────────────────────────────────────
  // options: [{ id, label, pulse }]
  function OverlayToggle({ options, defaultValue, onChange }) {
    const [active, setActive] = useState(defaultValue || options[0].id);
    return (
      <div className="overlay-toggle">
        {options.map(o => (
          <button key={o.id} className={o.id === active ? 'active' : ''}
            onClick={() => { setActive(o.id); onChange && onChange(o.id); }}>
            {o.pulse && o.id === active ? <span className="pulse" /> : null}{o.label}
          </button>
        ))}
      </div>
    );
  }

  // ── AutoScrollSwitch ────────────────────────────────────────
  function AutoScrollSwitch({ defaultOn = true, label = 'Auto-scroll', onChange }) {
    const [on, setOn] = useState(defaultOn);
    return (
      <div className={'auto-switch' + (on ? '' : ' off')}
        onClick={() => { setOn(o => { onChange && onChange(!o); return !o; }); }}>
        <span className="sw" />{label}
      </div>
    );
  }

  // ── ScopeChip + ScopeRow ────────────────────────────────────
  function ScopeChip({ label, n, active, err, pulse, onClick }) {
    const cls = 'scope-chip' + (err ? ' err' : '') + (active ? ' active' : '');
    return (
      <span className={cls} onClick={onClick}>
        {label}{n != null ? <span className="n">{pulse && active ? <span className="pulse" /> : null}{n}</span> : null}
      </span>
    );
  }
  // scopes: [{ id, label, n, err } | { sep:true }] ; single-select
  function ScopeRow({ scopes, defaultValue, onChange }) {
    const first = (scopes.find(s => !s.sep) || {}).id;
    const [active, setActive] = useState(defaultValue || first);
    return (
      <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
        {scopes.map((s, i) => s.sep
          ? <span key={'sep' + i} className="scope-sep" />
          : <ScopeChip key={s.id} {...s} active={s.id === active}
              onClick={() => { setActive(s.id); onChange && onChange(s.id); }} />
        )}
      </div>
    );
  }

  // ── LevelSelect ─────────────────────────────────────────────
  function LevelSelect({ options = ['All levels', 'Epics only', 'Tickets', 'Tasks'], onChange }) {
    return (
      <select onChange={e => onChange && onChange(e.target.value)}
        style={{ background: 'var(--bg-1)', border: '1px solid var(--line-strong)', color: 'var(--fg-mute)', padding: '6px 10px', borderRadius: 'var(--r-sm)', fontFamily: 'var(--mono)', fontSize: 'var(--text-11)' }}>
        {options.map(o => <option key={o}>{o}</option>)}
      </select>
    );
  }

  // ── TopBar ──────────────────────────────────────────────────
  function TopBar({ project = 'sacrum', page = 'Tasks', running = 3, total = 100 }) {
    return (
      <div className="c-topbar">
        <span className="brand">Vertebrae<span className="ember" /></span>
        <span className="crumb">{project}<span className="sep">›</span><span className="page">{page}</span></span>
        <span className="activity">
          {running ? <span className="live"><span className="pulse" />{running} running</span> : null}
          <span className="total"><b>{total}</b> tasks</span>
          <span style={{ color: 'var(--fg-faint)' }}>⌘K</span>
        </span>
      </div>
    );
  }

  // ── SideRail ────────────────────────────────────────────────
  // items: [{ id, icon }] ; active id
  function SideRail({ items, active, height = 200, onSelect }) {
    return (
      <div className="c-siderail" style={{ height }}>
        <div className="logo">s</div>
        <hr />
        {items.map(it => (
          <div key={it.id} className={'item' + (it.id === active ? ' active' : '')}
            title={it.id} onClick={() => onSelect && onSelect(it.id)}>
            {typeof it.icon === 'string' ? Icons[it.icon] : it.icon}
          </div>
        ))}
        <div className="conn"><span className="dot" />connected</div>
      </div>
    );
  }

  Object.assign(window, {
    Button, IconButton, SearchBar, ViewTabs, OverlayToggle, AutoScrollSwitch,
    ScopeChip, ScopeRow, LevelSelect, TopBar, SideRail, HearthIcons: Icons,
  });
})();
