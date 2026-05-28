/* ──────────────────────────────────────────────────────────────────
   Hearth component library · App shell
   Full-bleed application chrome: AppTopBar, AppSideRail, AppShell.
   Distinct from the catalog's demo-styled TopBar/SideRail — these are the
   real frame used by Tasks / Board / Design / Traces.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const RAIL_ICONS = {
    ops: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>,
    tasks: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>,
    board: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="18" rx="1" /><rect x="14" y="3" width="7" height="11" rx="1" /></svg>,
    design: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="6" r="3" /><circle cx="19" cy="6" r="3" /><circle cx="12" cy="18" r="3" /><path d="m7 8 4 8M17 8l-4 8" /></svg>,
    traces: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h4l3-9 4 18 3-9h4" /></svg>,
  };

  // Canonical nav — order matches the product rail.
  const NAV = [
    { id: 'ops', icon: 'ops', title: 'Operations', href: null },
    { id: 'tasks', icon: 'tasks', title: 'Tasks', href: 'tasks-v2.html' },
    { id: 'board', icon: 'board', title: 'Board', href: 'board-v2.html' },
    { id: 'design', icon: 'design', title: 'Design', href: 'design-v2.html' },
    { id: 'traces', icon: 'traces', title: 'Traces', href: 'traces-v2.html' },
  ];

  function AppSideRail({ active }) {
    return (
      <aside className="app-rail">
        <div className="logo">s</div>
        <hr />
        {NAV.map(it => {
          const cls = 'item' + (it.id === active ? ' active' : '');
          const inner = RAIL_ICONS[it.icon];
          return it.href && it.id !== active
            ? <a key={it.id} className={cls} href={it.href} title={it.title}>{inner}</a>
            : <div key={it.id} className={cls} title={it.title}>{inner}</div>;
        })}
        <div className="sys"><span className="conn" title="Connected" /><span>connected</span></div>
      </aside>
    );
  }

  // page: breadcrumb page name · activity: node rendered in the right slot
  function AppTopBar({ project = 'sacrum', page, activity, kbd = true }) {
    return (
      <div className="app-topbar">
        <span className="brand">Vertebrae<span className="ember" /></span>
        <span className="crumb">{project} <span className="sep">›</span> <span className="page">{page}</span></span>
        <div className="activity">
          {activity}
          {kbd ? <span className="kbd"><kbd>⌘</kbd><kbd>K</kbd></span> : null}
        </div>
      </div>
    );
  }

  // Composer: topbar over [rail + page content]. Children fill the frame to the right of the rail.
  function AppShell({ page, active, project, activity, kbd, children }) {
    return (
      <>
        <AppTopBar page={page} project={project} activity={activity} kbd={kbd} />
        <div className="app-frame">
          <AppSideRail active={active} />
          {children}
        </div>
      </>
    );
  }

  // Small helper: the live "N running" pulse readout used in topbars.
  function LiveCount({ running }) {
    if (!running) return null;
    return <span className="live"><span className="pulse" />{running} running</span>;
  }

  Object.assign(window, { AppShell, AppTopBar, AppSideRail, LiveCount });
})();
