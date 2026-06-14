/* ──────────────────────────────────────────────────────────────────
   Vertebrae · Hearth — First Run
   "Light the hearth." A no-chrome initialization flow that runs before
   any project exists. Three phases on one floating glass panel:
     1 · RUNTIME  — install the binaries (streaming package log)
     2 · PROJECT  — point at a repo, detect what's there
     3 · SKILLS   — scaffold skill files + docs into the project
   Resolves into an ignition moment that drops you into the app.
   ──────────────────────────────────────────────────────────────────── */
const { useState, useEffect, useRef, useCallback } = React;

/* ── Icons ── */
const Ic = {
  arrow: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
  back: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  check: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>,
  cube: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
  daemon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>,
  shield: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  search: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  folder: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>,
  spark: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  info: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
};

const GLYPH = { cube: Ic.cube, daemon: Ic.daemon, shield: Ic.shield, search: Ic.search };

/* ── Data ── */
const PHASES = [
  { kind: 'Phase 01', name: 'Runtime' },
  { kind: 'Phase 02', name: 'Project' },
  { kind: 'Phase 03', name: 'Skills & Docs' },
];

const BINARIES = [
  { id: 'vertebrae', glyph: 'cube',   ver: 'v3.2.0', size: 14.2, desc: 'CLI & orchestrator' },
  { id: 'vrt-agentd', glyph: 'daemon', ver: 'v3.2.0', size: 28.6, desc: 'local runtime daemon' },
  { id: 'vrt-sandbox', glyph: 'shield', ver: 'v1.4.1', size: 9.1, desc: 'sandboxed exec runner' },
  { id: 'ripgrep',    glyph: 'search', ver: 'v14.1',  size: 4.7, desc: 'fast code search (dep)' },
];

const SKILLS = [
  { id: 'run-tests',   desc: 'Execute the test suite and report failures inline.', on: true },
  { id: 'code-review', desc: 'Review diffs against the spec before a run can finish.', on: true },
  { id: 'tracker-sync', desc: 'Keep tasks and board columns in sync as runs progress.', on: true },
  { id: 'git-ops',     desc: 'Branch, commit, and open pull requests on your behalf.', on: true },
  { id: 'doc-writer',  desc: 'Draft and update docs from the changes in a run.', on: false },
];

/* ════════════════════════════════════════════════════════════════
   Phase 1 · Runtime — streaming binary install
   ════════════════════════════════════════════════════════════════ */
function PhaseRuntime({ done, onDone }) {
  // state per binary: { phase: 'queued'|'download'|'verify'|'done', pct }
  const [items, setItems] = useState(() => BINARIES.map(() => ({ phase: 'queued', pct: 0 })));
  const started = useRef(false);
  const timers = useRef([]);

  useEffect(() => {
    if (done) { setItems(BINARIES.map(() => ({ phase: 'done', pct: 100 }))); return; }
    if (started.current) return;
    started.current = true;
    let idx = 0;
    const runItem = () => {
      if (idx >= BINARIES.length) { onDone(); return; }
      const i = idx;
      setItems((s) => s.map((it, j) => j === i ? { phase: 'download', pct: 0 } : it));
      const step = () => {
        setItems((s) => {
          const cur = s[i];
          const next = Math.min(100, cur.pct + 7 + Math.random() * 13);
          const arr = s.map((it, j) => j === i ? { ...it, pct: next } : it);
          if (next >= 100) {
            timers.current.push(setTimeout(() => {
              setItems((ss) => ss.map((it, j) => j === i ? { phase: 'verify', pct: 100 } : it));
              timers.current.push(setTimeout(() => {
                setItems((ss) => ss.map((it, j) => j === i ? { phase: 'done', pct: 100 } : it));
                idx++; timers.current.push(setTimeout(runItem, 220));
              }, 360));
            }, 120));
          } else {
            timers.current.push(setTimeout(step, 70));
          }
          return arr;
        });
      };
      timers.current.push(setTimeout(step, 240));
    };
    timers.current.push(setTimeout(runItem, 420));
    return () => timers.current.forEach(clearTimeout);
  }, []);

  const total = BINARIES.reduce((a, b) => a + b.size, 0);
  const fetched = items.reduce((a, it, i) => a + (it.phase === 'done' ? BINARIES[i].size : it.phase === 'download' ? BINARIES[i].size * it.pct / 100 : it.phase === 'verify' ? BINARIES[i].size : 0), 0);

  const stateLabel = (it) => {
    if (it.phase === 'queued') return <span className="fr-bin-state queued">queued</span>;
    if (it.phase === 'download') return <span className="fr-bin-state work"><span className="fr-spin" />{Math.round(it.pct)}%</span>;
    if (it.phase === 'verify') return <span className="fr-bin-state work"><span className="fr-spin" />verify</span>;
    return <span className="fr-bin-state done">{Ic.check} linked</span>;
  };

  return (
    <>
      <div className="fr-c-head">
        <div className="key">Phase 01 · Runtime</div>
        <h1>Install the binaries</h1>
        <p className="lede">Vertebrae lays down a small toolchain on this machine before it can plan, run, and sandbox agents.</p>
      </div>
      <div className="fr-scroll">
        <div className="fr-bins">
          {BINARIES.map((b, i) => {
            const it = items[i];
            const cls = 'fr-bin ' + (it.phase === 'done' ? 'done' : it.phase === 'queued' ? 'queued' : 'active');
            return (
              <div key={b.id} className={cls}>
                <div className="fr-bin-top">
                  <span className="fr-bin-glyph" style={{ color: it.phase === 'done' ? 'var(--ok)' : it.phase === 'queued' ? 'var(--fg-faint)' : 'var(--accent)' }}>{GLYPH[b.glyph]}</span>
                  <span className="fr-bin-name">{b.id}</span>
                  <span className="fr-bin-ver">{b.ver}</span>
                  <span className="fr-bin-desc">{b.desc}</span>
                  {stateLabel(it)}
                </div>
                <div className="fr-bin-prog"><div className="fr-bin-prog-fill" style={{ width: it.pct + '%' }} /></div>
              </div>
            );
          })}
        </div>
        <div className="fr-pathnote">
          {Ic.info}<span>Symlinked into <code>/usr/local/bin</code> · already on your <code>PATH</code></span>
        </div>
      </div>
      <FooterMeta left={done
        ? <span className="note"><b>4 binaries</b> · {total.toFixed(1)} MB linked</span>
        : <span className="note">{fetched.toFixed(1)} / {total.toFixed(1)} MB · <b>{items.filter(i => i.phase === 'done').length}/4</b> linked</span>} />
    </>
  );
}

/* ════════════════════════════════════════════════════════════════
   Phase 2 · Project — pick a folder, detect what's there
   ════════════════════════════════════════════════════════════════ */
function PhaseProject({ project, setProject }) {
  const pick = () => {
    setProject({ ...project, folder: '~/work/cervical', name: project.name || 'cervical', detected: true });
  };
  return (
    <>
      <div className="fr-c-head">
        <div className="key">Phase 02 · Project</div>
        <h1>Add your first project</h1>
        <p className="lede">Point Vertebrae at a repository. It reads what's already there before writing anything of its own.</p>
      </div>
      <div className="fr-scroll">
        <div className="fr-field">
          <label>Repository folder</label>
          <div className="fr-folder">
            <span className="fic">{Ic.folder}</span>
            <span className={'fpath' + (project.folder ? '' : ' ph')}>{project.folder || 'No folder selected'}</span>
            <button className="fr-btn" style={{ height: 28, padding: '0 12px', fontSize: 'var(--text-12)' }} onClick={pick}>{project.folder ? 'Change…' : 'Choose folder…'}</button>
          </div>
        </div>
        <div className="fr-field">
          <label>Project name</label>
          <input className="fr-input" placeholder="e.g. cervical" value={project.name}
            onChange={(e) => setProject({ ...project, name: e.target.value })} />
        </div>
        {project.detected ? (
          <div className="fr-detect">
            <div className="fr-detect-hd"><span className="ok-dot" />Repository read</div>
            <div className="fr-drow"><span className="dk">Version</span><span className="dv"><span className="mono">git</span> · branch <span className="mono accent">main</span> · clean tree</span></div>
            <div className="fr-drow"><span className="dk">Language</span><span className="dv">TypeScript · Node 20 · <span className="mono">pnpm</span></span></div>
            <div className="fr-drow"><span className="dk">Size</span><span className="dv"><span className="mono">1,284</span> files · 47k LOC · last commit 2d ago</span></div>
            <div className="fr-drow"><span className="dk">Existing</span><span className="dv">no <span className="mono">.vertebrae/</span> — this will be a fresh install</span></div>
          </div>
        ) : (
          <div className="fr-callout"><span className="ci">{Ic.info}</span><span>Choose a folder to let Vertebrae <em>read the repo</em> — language, version control, and whether a kit already lives here.</span></div>
        )}
      </div>
      <FooterMeta left={project.detected
        ? <span className="note">Will scaffold into <b>{project.folder}/.vertebrae</b></span>
        : <span className="note">No repository selected yet</span>} />
    </>
  );
}

/* ════════════════════════════════════════════════════════════════
   Phase 3 · Skills & Docs — toggle skills, watch the scaffold write
   ════════════════════════════════════════════════════════════════ */
function PhaseSkills({ project, skills, setSkills, writing, fileStates, onScaffold, scaffolded }) {
  const onCount = skills.filter(Boolean).length;

  // Build the file manifest from selected skills
  const files = [];
  files.push({ id: 'config', ind: true, nm: 'config.toml', ds: 'connection & settings', kind: 'file' });
  files.push({ id: 'agents', ind: false, nm: 'AGENTS.md', ds: 'guidance read each run', kind: 'doc' });
  files.push({ id: 'readme', ind: true, nm: 'README.md', ds: 'how the kit works', kind: 'doc' });
  SKILLS.forEach((s, i) => { if (skills[i]) files.push({ id: 'sk-' + s.id, ind: true, nm: s.id + '.md', ds: 'skill', kind: 'skill' }); });

  const fstate = (id) => {
    if (scaffolded) return 'done';
    if (!writing) return 'idle';
    return fileStates[id] || 'queued';
  };

  return (
    <>
      <div className="fr-c-head">
        <div className="key">Phase 03 · Skills &amp; Docs</div>
        <h1>Equip <em style={{ fontStyle: 'normal', color: 'var(--accent)' }}>{project.name || 'the project'}</em></h1>
        <p className="lede">Pick the skills the agent may use here. Vertebrae writes them — plus the docs it reads each run — into the repo.</p>
      </div>
      <div className="fr-scroll">
        <div className="fr-sec-lbl"><span className="t">Skills to install</span><span className="n">{onCount} of {SKILLS.length} on</span></div>
        <div className="fr-skills">
          {SKILLS.map((s, i) => (
            <div key={s.id} className={'fr-skill ' + (skills[i] ? 'on' : 'off')}>
              <div className="si">
                <div className="sn"><span className="glyph">{Ic.spark}</span>{s.id}</div>
                <div className="sd">{s.desc}</div>
              </div>
              <div className={'fr-tog' + (skills[i] ? ' on' : '')} role="switch" aria-checked={skills[i]}
                onClick={() => { if (!writing && !scaffolded) setSkills((sk) => sk.map((v, j) => j === i ? !v : v)); }}
                style={{ opacity: (writing || scaffolded) ? 0.55 : 1, cursor: (writing || scaffolded) ? 'default' : 'pointer' }} />
            </div>
          ))}
        </div>

        <div className="fr-sec-lbl"><span className="t">Files it writes</span><span className="n">{files.length + 1} files</span></div>
        <div className="fr-tree">
          <div className="fr-tr"><span className="nm dir">.vertebrae/</span><span className="ds">agent kit · committed to git</span></div>
          {files.map((f) => {
            const st = fstate(f.id);
            return (
              <div key={f.id} className={'fr-tr' + (f.ind ? ' ind' : '') + (st === 'queued' ? ' queued' : '')}>
                <span className={'nm' + (f.kind === 'skill' ? '' : '')}>{f.kind === 'skill' ? 'skills/' : ''}{f.nm}</span>
                <span className="ds">{f.ds}</span>
                {st === 'work' ? <span className="fstate work"><span className="fr-spin" />writing</span>
                  : st === 'done' ? <span className="fstate done">{Ic.check} written</span>
                  : st === 'queued' ? <span className="fstate queued">queued</span> : null}
              </div>
            );
          })}
        </div>

        <div className="fr-callout"><span className="ci">{Ic.info}</span><span>Scaffolded into your repo and committed on the first run. <em>Everything is editable</em> — rewrite a skill or drop one whenever you like.</span></div>
      </div>
      <FooterMeta left={scaffolded
        ? <span className="note"><b>{files.length + 1} files</b> · <b>{onCount} skills</b> committed</span>
        : <span className="note">Adds <b>{files.length + 1} files</b> · <b>{onCount} skills</b></span>} />
    </>
  );
}

/* ════════════════════════════════════════════════════════════════
   Ignition
   ════════════════════════════════════════════════════════════════ */
function Ignition({ project, skillCount }) {
  return (
    <div className="fr-ignite">
      <div className="fr-flame" />
      <div className="key">Initialized</div>
      <h1>Project ready</h1>
      <p className="sub">Vertebrae is installed and <em style={{ color: 'var(--fg-soft)' }}>{project.name}</em> is connected. Runs you start here will plan, execute, and report against this repo.</p>
      <div className="fr-summary">
        <div className="fr-sum"><div className="v">4</div><div className="l">binaries</div></div>
        <div className="fr-sum"><div className="v">{skillCount}</div><div className="l">skills</div></div>
        <div className="fr-sum"><div className="v">{project.name}</div><div className="l">project</div></div>
      </div>
      <a className="fr-btn primary lg" href="operations-v2.html">Enter {project.name} {Ic.arrow}</a>
    </div>
  );
}

/* ── shared footer-meta slot (left side text) ── */
let _footerLeft = null;
function FooterMeta({ left }) {
  // store into a ref via context-free approach: render nothing, App reads via portal? simpler: lift state.
  return null; // footer is rendered by App; this kept for clarity / unused
}

/* ════════════════════════════════════════════════════════════════
   App
   ════════════════════════════════════════════════════════════════ */
function App() {
  const [phase, setPhase] = useState(0);          // 0,1,2 phases · 3 = ignition
  const [runtimeDone, setRuntimeDone] = useState(false);
  const [project, setProject] = useState({ folder: '', name: '', detected: false });
  const [skills, setSkills] = useState(SKILLS.map((s) => s.on));
  const [writing, setWriting] = useState(false);
  const [scaffolded, setScaffolded] = useState(false);
  const [fileStates, setFileStates] = useState({});
  const timers = useRef([]);

  const skillCount = skills.filter(Boolean).length;

  // Phase 3 scaffold runner
  const runScaffold = useCallback(() => {
    if (writing || scaffolded) return;
    const ids = ['config', 'agents', 'readme'];
    SKILLS.forEach((s, i) => { if (skills[i]) ids.push('sk-' + s.id); });
    setWriting(true);
    setFileStates(Object.fromEntries(ids.map((id) => [id, 'queued'])));
    let k = 0;
    const next = () => {
      if (k >= ids.length) {
        timers.current.push(setTimeout(() => { setScaffolded(true); setWriting(false); }, 260));
        return;
      }
      const id = ids[k];
      setFileStates((fs) => ({ ...fs, [id]: 'work' }));
      timers.current.push(setTimeout(() => {
        setFileStates((fs) => ({ ...fs, [id]: 'done' }));
        k++; timers.current.push(setTimeout(next, 130));
      }, 280 + Math.random() * 220));
    };
    timers.current.push(setTimeout(next, 200));
  }, [skills, writing, scaffolded]);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // ── Footer button wiring per phase ──
  let canAdvance = false, primaryLabel = 'Continue', primaryAction = () => {};
  if (phase === 0) {
    canAdvance = runtimeDone;
    primaryLabel = 'Continue';
    primaryAction = () => setPhase(1);
  } else if (phase === 1) {
    canAdvance = project.detected && !!project.name.trim();
    primaryLabel = 'Continue';
    primaryAction = () => setPhase(2);
  } else if (phase === 2) {
    if (!scaffolded) {
      canAdvance = !writing;
      primaryLabel = writing ? 'Writing…' : 'Scaffold & commit';
      primaryAction = runScaffold;
    } else {
      canAdvance = true;
      primaryLabel = 'Light the hearth';
      primaryAction = () => setPhase(3);
    }
  }

  const progress = phase === 3 ? 100 : ((phase + (phase === 0 && runtimeDone ? 1 : phase === 1 && canAdvance ? 1 : phase === 2 && scaffolded ? 1 : 0.35)) / 3) * 100;

  // Footer meta text per phase
  const footerNote = (() => {
    if (phase === 0) return runtimeDone
      ? <span className="note"><b>4 binaries</b> linked · 56.6 MB</span>
      : <span className="note">Fetching runtime…</span>;
    if (phase === 1) return project.detected
      ? <span className="note">Scaffolds into <b>{project.folder}/.vertebrae</b></span>
      : <span className="note">No repository selected yet</span>;
    if (phase === 2) {
      const fc = 3 + skillCount + 1;
      return scaffolded
        ? <span className="note"><b>{fc} files</b> · <b>{skillCount} skills</b> committed</span>
        : <span className="note">Adds <b>{fc} files</b> · <b>{skillCount} skills</b></span>;
    }
    return null;
  })();

  return (
    <div className={'fr-stage' + (phase === 3 ? ' lit' : '')}>
      <div className="fr-card">
        {/* Masthead */}
        <div className="fr-head">
          <span className="fr-wordmark">Vertebrae<span className="ember" /></span>
          <span className="fr-divider" />
          <span className="fr-eyebrow">First run · Initialize</span>
          <div className="fr-head-right">
            {phase < 3 ? <span className="fr-step-count">Step <b>{phase + 1}</b> of 3</span> : <span className="fr-step-count">Ready</span>}
          </div>
        </div>

        {/* Progress */}
        <div className="fr-bar"><div className="fr-bar-fill" style={{ width: progress + '%' }} /></div>

        {phase === 3 ? (
          <Ignition project={project} skillCount={skillCount} />
        ) : (
          <>
            <div className="fr-body">
              {/* Spine */}
              <div className="fr-spine">
                {PHASES.map((p, i) => {
                  const state = i < phase ? 'done' : i === phase ? 'active' : 'todo';
                  // mark current as done in spine number once its work completes
                  const showDone = state === 'done' || (i === 0 && phase === 0 && runtimeDone && false);
                  return (
                    <div key={i} className={'fr-phase ' + (state === 'done' ? 'done' : state === 'active' ? 'active' : '')}>
                      <span className="fr-pnum">{state === 'done' ? Ic.check : String(i + 1).padStart(2, '0')}</span>
                      <span className="fr-pmeta">
                        <span className="fr-pkind">{p.kind}</span>
                        <span className="fr-pname">{p.name}</span>
                      </span>
                    </div>
                  );
                })}
                <div className="fr-spine-foot">
                  <span className={'conn' + (runtimeDone ? ' live' : '')}><span className="pulse" />{runtimeDone ? 'daemon up' : 'offline'}</span>
                </div>
              </div>

              {/* Content */}
              <div className="fr-content">
                {phase === 0 && <PhaseRuntime done={runtimeDone} onDone={() => setRuntimeDone(true)} />}
                {phase === 1 && <PhaseProject project={project} setProject={setProject} />}
                {phase === 2 && <PhaseSkills project={project} skills={skills} setSkills={setSkills}
                  writing={writing} fileStates={fileStates} scaffolded={scaffolded} onScaffold={runScaffold} />}
              </div>
            </div>

            {/* Footer */}
            <div className="fr-foot">
              {footerNote}
              <span className="sp">
                {phase > 0 && !writing ? <button className="fr-btn ghost" onClick={() => setPhase(phase - 1)}>{Ic.back} Back</button> : null}
                <button className="fr-btn primary" disabled={!canAdvance} onClick={primaryAction}>
                  {primaryLabel} {!writing && Ic.arrow}
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
