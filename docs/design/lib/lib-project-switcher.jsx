/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Project switcher + Add-project flow
   Clicking the rail logo opens a floating switcher anchored to the mark.
   "Add a project" opens a scaffold panel that previews the files + agent
   skills Vertebrae writes into the repo on first run.

   Mounted once by AppShell. Controlled by props:
     open      — popover visible
     current   — active project name
     onClose() — dismiss popover
     onSwitch(project) — { name, letter } chosen / created
   ──────────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useEffect, useRef } = React;

  /* ── Styles ── */
  const CSS = `
  /* Outside-click catcher */
  .ps-scrim-pop { position: fixed; inset: 0; z-index: 9994; background: transparent; }

  /* Popover */
  .ps-pop {
    position: fixed; left: 54px; top: 46px; z-index: 9995;
    width: 288px; max-height: calc(100vh - 64px);
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg-2);
    border: 1px solid var(--line-strong); border-left: 3px solid var(--accent);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow-3), 0 0 36px rgba(0,0,0,0.34);
    animation: ps-pop-in var(--t-base) var(--ease);
    transform-origin: top left;
  }
  @keyframes ps-pop-in { from { transform: translateY(-6px) scale(0.98); } to { transform: none; } }
  .ps-pop::before {
    content: ''; position: absolute; left: -7px; top: 16px;
    width: 12px; height: 12px; background: var(--bg-2);
    border-left: 1px solid var(--line-strong); border-bottom: 1px solid var(--line-strong);
    transform: rotate(45deg);
  }

  .ps-pop-hd { display: flex; align-items: center; gap: var(--s-2); padding: var(--s-2h) var(--s-3) var(--s-2); border-bottom: 1px solid var(--line); }
  .ps-pop-hd .lbl { font-family: var(--mono); font-size: var(--text-10); letter-spacing: 0.18em; text-transform: uppercase; color: var(--fg-faint); }
  .ps-pop-hd .count { margin-left: auto; font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); background: var(--bg); border: 1px solid var(--line-strong); border-radius: var(--r-xs); padding: 1px var(--s-1h); }

  .ps-search { display: flex; align-items: center; gap: var(--s-1h); margin: var(--s-2) var(--s-3) var(--s-1); padding: var(--s-1) var(--s-2); background: var(--bg-1); border: 1px solid var(--line-strong); border-radius: var(--r-sm); }
  .ps-search svg { color: var(--fg-faint); flex-shrink: 0; }
  .ps-search input { flex: 1; min-width: 0; background: transparent; border: none; outline: none; color: var(--fg); font-family: var(--sans); font-size: var(--text-12); }
  .ps-search input::placeholder { color: var(--fg-faint); }

  .ps-list { overflow-y: auto; padding: var(--s-1h); display: flex; flex-direction: column; gap: var(--s-0); }
  .ps-list::-webkit-scrollbar { width: 5px; }
  .ps-list::-webkit-scrollbar-thumb { background: var(--bg-4); border-radius: var(--r-sm); }

  .ps-row { display: grid; grid-template-columns: 28px 1fr auto; gap: var(--s-2); align-items: center; padding: var(--s-1h) var(--s-2); border-radius: var(--r-sm); cursor: pointer; border: 1px solid transparent; transition: background var(--t-fast) var(--ease); text-align: left; background: transparent; }
  .ps-row:hover { background: var(--bg-1); }
  .ps-row.active { background: var(--accent-wash); border-color: color-mix(in oklch, var(--accent) 28%, transparent); }
  .ps-av { width: 28px; height: 28px; border-radius: var(--r-md); display: flex; align-items: center; justify-content: center; font-family: var(--serif); font-style: italic; font-size: var(--text-15); background: var(--bg-3); color: var(--fg-soft); border: 1px solid var(--line-strong); }
  .ps-row.active .ps-av { background: var(--accent); color: var(--bg); border-color: var(--accent); box-shadow: 0 0 10px var(--accent-glow); }
  .ps-row.archived .ps-av { opacity: 0.5; }
  .ps-meta { min-width: 0; }
  .ps-name { font-family: var(--serif); font-style: italic; font-size: var(--text-14); color: var(--fg); letter-spacing: -0.01em; line-height: 1.15; }
  .ps-row.active .ps-name { color: var(--accent); }
  .ps-path { font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
  .ps-stat { font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); display: inline-flex; align-items: center; gap: var(--s-1); white-space: nowrap; }
  .ps-stat.live { color: var(--accent); }
  .ps-stat .pulse { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 5px var(--accent-glow); animation: app-pulse 1.6s ease-in-out infinite; }
  .ps-check { color: var(--accent); display: flex; }

  .ps-pop-ft { border-top: 1px solid var(--line); padding: var(--s-1h); }
  .ps-add { display: flex; align-items: center; gap: var(--s-2); width: 100%; padding: var(--s-2) var(--s-2); background: transparent; border: 1px dashed var(--line-strong); border-radius: var(--r-sm); color: var(--fg-mute); font-family: var(--sans); font-size: var(--text-13); cursor: pointer; transition: all var(--t-fast) var(--ease); }
  .ps-add:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-wash); }
  .ps-add .pl { width: 22px; height: 22px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: var(--r-sm); background: var(--bg-3); border: 1px solid var(--line-strong); }
  .ps-add:hover .pl { background: var(--accent); color: var(--bg); border-color: var(--accent); }

  /* ── Add-project modal ── */
  .ps-scrim { position: fixed; inset: 0; z-index: 9996; background: color-mix(in oklch, var(--bg) 62%, transparent); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); display: flex; align-items: flex-start; justify-content: center; padding: 7vh var(--s-5) var(--s-5); overflow-y: auto; }
  .ps-modal {
    width: 540px; max-width: 100%;
    background: var(--bg-2); border: 1px solid var(--line-strong); border-top: 3px solid var(--accent);
    border-radius: var(--r-lg); box-shadow: var(--shadow-3), 0 0 60px rgba(0,0,0,0.5);
    overflow: hidden; animation: ps-modal-in var(--t-base) var(--ease);
  }
  @keyframes ps-modal-in { from { transform: translateY(10px); } to { transform: none; } }

  .ps-mh { padding: var(--s-5) var(--s-5) var(--s-4); border-bottom: 1px solid var(--line); display: flex; align-items: flex-start; gap: var(--s-3); }
  .ps-mh .eyebrow { font-family: var(--mono); font-size: var(--text-10); letter-spacing: 0.18em; text-transform: uppercase; color: var(--accent); }
  .ps-mh h2 { font-family: var(--serif); font-size: var(--text-28); font-style: italic; font-weight: 400; letter-spacing: -0.02em; color: var(--fg); line-height: 1.05; margin: var(--s-1) 0 var(--s-1); }
  .ps-mh p { font-family: var(--serif); font-size: var(--text-14); color: var(--fg-mute); line-height: 1.5; max-width: 42ch; }
  .ps-mh .x { margin-left: auto; width: 28px; height: 28px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: var(--fg-mute); background: transparent; border: 1px solid var(--line-strong); border-radius: var(--r-sm); cursor: pointer; transition: all var(--t-fast) var(--ease); }
  .ps-mh .x:hover { color: var(--fg); border-color: var(--fg-faint); }

  .ps-mb { padding: var(--s-5); display: flex; flex-direction: column; gap: var(--s-5); max-height: 58vh; overflow-y: auto; }
  .ps-mb::-webkit-scrollbar { width: 7px; }
  .ps-mb::-webkit-scrollbar-thumb { background: var(--bg-4); border-radius: var(--r-md); }

  .ps-field { display: flex; flex-direction: column; gap: var(--s-1h); }
  .ps-field > label { font-family: var(--mono); font-size: var(--text-10); letter-spacing: 0.14em; text-transform: uppercase; color: var(--fg-faint); }
  .ps-folder { display: flex; align-items: center; gap: var(--s-2); padding: var(--s-2) var(--s-2h); background: var(--bg-1); border: 1px solid var(--line-strong); border-radius: var(--r-md); }
  .ps-folder .fic { color: var(--fg-faint); display: flex; flex-shrink: 0; }
  .ps-folder .fpath { flex: 1; min-width: 0; font-family: var(--mono); font-size: var(--text-12); color: var(--fg-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ps-folder .fpath.ph { color: var(--fg-faint); }
  .ps-folder .browse { flex-shrink: 0; }
  .ps-input { height: 36px; padding: 0 var(--s-2h); background: var(--bg-1); border: 1px solid var(--line-strong); border-radius: var(--r-md); font-family: var(--sans); font-size: var(--text-14); color: var(--fg); outline: none; transition: all var(--t-fast) var(--ease); }
  .ps-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-wash); }
  .ps-input::placeholder { color: var(--fg-faint); }

  .ps-sec-lbl { display: flex; align-items: baseline; gap: var(--s-2); margin-bottom: var(--s-0); }
  .ps-sec-lbl .t { font-family: var(--serif); font-size: var(--text-18); font-style: italic; color: var(--fg); letter-spacing: -0.01em; }
  .ps-sec-lbl .n { font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); }

  /* file tree */
  .ps-tree { background: var(--bg-1); border: 1px solid var(--line); border-radius: var(--r-md); padding: var(--s-2h) var(--s-3); font-family: var(--mono); font-size: var(--text-12); display: flex; flex-direction: column; gap: var(--s-1h); }
  .ps-tree .tr { display: flex; align-items: center; gap: var(--s-2); color: var(--fg-soft); }
  .ps-tree .tr.ind { padding-left: var(--s-4h); }
  .ps-tree .tr .nm { color: var(--fg); flex-shrink: 0; }
  .ps-tree .tr .nm.dir { color: var(--accent); }
  .ps-tree .tr .ds { color: var(--fg-faint); font-family: var(--sans); font-size: var(--text-11); line-height: 1.3; margin-left: auto; text-align: right; flex: 0 1 auto; }
  .ps-tree .tr .badge-new { flex-shrink: 0; font-family: var(--mono); font-size: var(--text-9); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ok); background: var(--ok-wash); border: 1px solid color-mix(in oklch, var(--ok) 30%, transparent); border-radius: var(--r-xs); padding: 0 var(--s-1); }

  /* skills */
  .ps-skills { display: flex; flex-direction: column; gap: var(--s-1h); }
  .ps-skill { display: grid; grid-template-columns: 1fr auto; gap: var(--s-2h); align-items: center; padding: var(--s-2) var(--s-2h); background: var(--bg-1); border: 1px solid var(--line-strong); border-radius: var(--r-md); transition: border-color var(--t-fast) var(--ease); }
  .ps-skill.on { border-color: color-mix(in oklch, var(--step-execute) 40%, var(--line-strong)); }
  .ps-skill .si { min-width: 0; }
  .ps-skill .sn { font-family: var(--mono); font-size: var(--text-12); color: var(--fg); display: flex; align-items: center; gap: var(--s-1h); }
  .ps-skill .sn .glyph { color: var(--step-execute-fg); display: flex; }
  .ps-skill.off .sn { color: var(--fg-mute); }
  .ps-skill .sd { font-family: var(--sans); font-size: var(--text-12); color: var(--fg-mute); margin-top: var(--s-0); line-height: 1.4; }
  .ps-tog { width: 36px; height: 20px; flex-shrink: 0; background: var(--bg-4); border: 1px solid var(--line-strong); border-radius: var(--r-full); position: relative; cursor: pointer; transition: all var(--t-base) var(--ease); }
  .ps-tog::after { content: ''; position: absolute; width: 14px; height: 14px; background: var(--fg-faint); border-radius: 50%; top: 2px; left: 2px; transition: all var(--t-base) var(--ease); }
  .ps-tog.on { background: var(--accent-wash); border-color: var(--accent-mute); box-shadow: 0 0 8px var(--accent-glow); }
  .ps-tog.on::after { background: var(--accent); transform: translateX(16px); box-shadow: 0 0 5px var(--accent-glow); }

  .ps-callout { display: flex; gap: var(--s-2h); padding: var(--s-3) var(--s-4); background: var(--accent-wash); border: 1px solid color-mix(in oklch, var(--accent) 32%, transparent); border-left: 3px solid var(--accent); border-radius: var(--r-md); font-family: var(--serif); font-size: var(--text-13); color: var(--fg-soft); line-height: 1.55; }
  .ps-callout .ci { color: var(--accent); flex-shrink: 0; margin-top: var(--s-0); }
  .ps-callout em { color: var(--accent); font-style: italic; }

  .ps-mf { padding: var(--s-3) var(--s-5); border-top: 1px solid var(--line); display: flex; align-items: center; gap: var(--s-3); background: var(--bg-1); }
  .ps-mf .note { font-family: var(--mono); font-size: var(--text-11); color: var(--fg-faint); }
  .ps-mf .note b { color: var(--fg-mute); font-weight: 500; }
  .ps-mf .sp { margin-left: auto; display: flex; gap: var(--s-2); }

  /* rail logo as trigger */
  .app-rail .logo { border: none; padding: 0; cursor: pointer; font-family: var(--serif); }
  .app-rail .logo[aria-expanded="true"] { box-shadow: 0 0 0 2px var(--accent), 0 0 14px var(--accent-glow); }
  `;

  function injectCSS() {
    if (document.getElementById('hearth-switcher-styles')) return;
    const s = document.createElement('style');
    s.id = 'hearth-switcher-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /* ── Icons ── */
  const I = {
    search: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>,
    plus: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>,
    check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>,
    close: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>,
    folder: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>,
    spark: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>,
    info: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>,
  };

  const PROJECTS = [
    { name: 'sacrum', letter: 's', path: '~/work/sacrum', running: 3 },
    { name: 'lumbar', letter: 'l', path: '~/work/lumbar', running: 0 },
    { name: 'atlas', letter: 'a', path: '~/work/atlas-api', running: 1 },
    { name: 'axis', letter: 'x', path: '~/work/axis', running: 0, archived: true },
  ];

  const SKILLS = [
    { id: 'run-tests', desc: 'Execute the project\u2019s test suite and report failures inline.', on: true },
    { id: 'code-review', desc: 'Review diffs against the spec before a run can finish.', on: true },
    { id: 'tracker-sync', desc: 'Keep tasks and board columns in sync as runs progress.', on: true },
    { id: 'git-ops', desc: 'Branch, commit, and open pull requests on your behalf.', on: true },
    { id: 'doc-writer', desc: 'Draft and update docs from the changes in a run.', on: false },
  ];

  function ScaffoldModal({ onClose, onCreate }) {
    const [folder, setFolder] = useState(null);
    const [name, setName] = useState('');
    const [skills, setSkills] = useState(SKILLS.map((s) => s.on));

    const pickFolder = () => { setFolder('~/work/cervical'); if (!name) setName('cervical'); };
    const toggle = (i) => setSkills((s) => s.map((v, j) => j === i ? !v : v));
    const onCount = skills.filter(Boolean).length;
    const fileCount = 4 + onCount; // base files + one skill file each
    const ready = !!folder && !!name.trim();

    return (
      <div className="ps-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="ps-modal" role="dialog" aria-modal="true">
          <div className="ps-mh">
            <div>
              <div className="eyebrow">Connect a repository</div>
              <h2>Add a project</h2>
              <p>Vertebrae installs a small agent kit into your repo so it can plan, run, and track work here.</p>
            </div>
            <button className="x" onClick={onClose} aria-label="Close">{I.close}</button>
          </div>

          <div className="ps-mb">
            {/* Folder */}
            <div className="ps-field">
              <label>Repository folder</label>
              <div className="ps-folder">
                <span className="fic">{I.folder}</span>
                <span className={'fpath' + (folder ? '' : ' ph')}>{folder || 'No folder selected'}</span>
                <button className="btn sm browse" onClick={pickFolder}>{folder ? 'Change…' : 'Choose folder…'}</button>
              </div>
            </div>

            {/* Name */}
            <div className="ps-field">
              <label>Project name</label>
              <input className="ps-input" placeholder="e.g. cervical" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            {/* Files */}
            <div>
              <div className="ps-sec-lbl"><span className="t">Files it will write</span><span className="n">{fileCount} files</span></div>
              <div className="ps-tree">
                <div className="tr"><span className="nm dir">.vertebrae/</span><span className="ds">agent kit, committed to git</span></div>
                <div className="tr ind"><span className="nm">config.toml</span><span className="ds">connection &amp; settings</span><span className="badge-new">new</span></div>
                <div className="tr ind"><span className="nm dir">workflows/</span><span className="ds">workflow definitions</span><span className="badge-new">new</span></div>
                <div className="tr ind"><span className="nm dir">skills/</span><span className="ds">{onCount} installed skill{onCount === 1 ? '' : 's'}</span><span className="badge-new">new</span></div>
                <div className="tr"><span className="nm">AGENTS.md</span><span className="ds">guidance read each run</span><span className="badge-new">new</span></div>
                <div className="tr"><span className="nm">.gitignore</span><span className="ds">+ run-cache entries</span></div>
              </div>
            </div>

            {/* Skills */}
            <div>
              <div className="ps-sec-lbl"><span className="t">Skills to install</span><span className="n">{onCount} of {SKILLS.length} on</span></div>
              <div className="ps-skills">
                {SKILLS.map((s, i) => (
                  <div key={s.id} className={'ps-skill ' + (skills[i] ? 'on' : 'off')}>
                    <div className="si">
                      <div className="sn"><span className="glyph">{I.spark}</span>{s.id}</div>
                      <div className="sd">{s.desc}</div>
                    </div>
                    <div className={'ps-tog' + (skills[i] ? ' on' : '')} onClick={() => toggle(i)} role="switch" aria-checked={skills[i]} />
                  </div>
                ))}
              </div>
            </div>

            <div className="ps-callout">
              <span className="ci">{I.info}</span>
              <span>These are scaffolded into your repository and committed on the first run. <em>Everything is editable</em> — rewrite a workflow or drop a skill whenever you like.</span>
            </div>
          </div>

          <div className="ps-mf">
            <span className="note">Adds <b>{fileCount} files</b> · <b>{onCount} skills</b></span>
            <span className="sp">
              <button className="btn ghost" onClick={onClose}>Cancel</button>
              <button className="btn primary" disabled={!ready} onClick={() => onCreate({ name: name.trim(), letter: name.trim()[0].toLowerCase() })}>
                {I.plus} Add project
              </button>
            </span>
          </div>
        </div>
      </div>
    );
  }

  function ProjectSwitcher({ open, current, onClose, onSwitch }) {
    injectCSS();
    const [adding, setAdding] = useState(false);
    const [q, setQ] = useState('');

    useEffect(() => {
      if (!open && !adding) return;
      const onKey = (e) => { if (e.key === 'Escape') { adding ? setAdding(false) : onClose(); } };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [open, adding, onClose]);

    useEffect(() => { if (!open) setAdding(false); }, [open]);

    const rows = PROJECTS.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));

    return (
      <>
        {open ? (
          <>
            <div className="ps-scrim-pop" onClick={onClose} />
            <div className="ps-pop" role="menu">
              <div className="ps-pop-hd">
                <span className="lbl">Projects</span>
                <span className="count">{PROJECTS.length}</span>
              </div>
              <div className="ps-search">
                {I.search}
                <input placeholder="Find a project…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
              </div>
              <div className="ps-list">
                {rows.map((p) => {
                  const active = p.name === current;
                  return (
                    <button key={p.name} className={'ps-row' + (active ? ' active' : '') + (p.archived ? ' archived' : '')}
                      onClick={() => onSwitch({ name: p.name, letter: p.letter })}>
                      <span className="ps-av">{p.letter}</span>
                      <span className="ps-meta">
                        <span className="ps-name">{p.name}</span>
                        <span className="ps-path">{p.path}</span>
                      </span>
                      {active ? <span className="ps-check">{I.check}</span>
                        : p.archived ? <span className="ps-stat">archived</span>
                        : p.running ? <span className="ps-stat live"><span className="pulse" />{p.running}</span>
                        : <span className="ps-stat">idle</span>}
                    </button>
                  );
                })}
                {rows.length === 0 ? <div style={{ padding: '14px 8px', fontFamily: 'var(--serif)', fontStyle: 'italic', color: 'var(--fg-faint)', fontSize: 'var(--text-13)' }}>No projects match.</div> : null}
              </div>
              <div className="ps-pop-ft">
                <button className="ps-add" onClick={() => setAdding(true)}>
                  <span className="pl">{I.plus}</span>
                  Add a project
                </button>
              </div>
            </div>
          </>
        ) : null}

        {adding ? (
          <ScaffoldModal
            onClose={() => setAdding(false)}
            onCreate={(p) => { setAdding(false); onSwitch(p); }}
          />
        ) : null}
      </>
    );
  }

  Object.assign(window, { ProjectSwitcher });
})();
