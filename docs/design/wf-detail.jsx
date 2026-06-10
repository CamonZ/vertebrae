/* ─────────────────────────────────────────────────────────────────
   Hearth · Workflow Graph — Inspector panel (window.WfInspector)
   Renders details for either a workflow box or a single step node,
   computed live from window.WFGraph (the single source of truth).
   Transitions are clickable so you can walk the topology from the panel.
   sel: { type:'workflow', wfId } | { type:'step', wfId, stepId }
   ───────────────────────────────────────────────────────────────── */
(function () {
  const { useState, useEffect } = React;

  const KIND_CLASS = (k) => 'k-' + (k === 'final' ? 'terminal' : k);
  const splitRef = (ref) => { const i = ref.indexOf('.'); return { wf: ref.slice(0, i), step: ref.slice(i + 1) }; };

  // deterministic short id (matches the canvas hash style) + pseudo timestamps
  function shortId(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(16).slice(0, 8).padStart(8, '0'); }
  function stamps(seed) {
    let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 131 + seed.charCodeAt(i)) >>> 0;
    const base = Date.UTC(2026, 3, 1); // 1 Apr 2026
    const created = base + (h % 26) * 864e5 + (h % 41040) * 60000;
    const updated = created + (3 + (h % 22)) * 864e5 + (h % 720) * 60000;
    const fmt = (t) => new Date(t).toLocaleString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    return { created: fmt(created), updated: fmt(updated) };
  }

  // liquid-template highlighter: wraps {{ … }} and {% … %} in coloured spans
  function highlightPrompt(text) {
    return text.split(/(\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\})/g).map((p, i) => {
      if (/^\{\{[\s\S]*\}\}$/.test(p)) return <span key={i} className="liq out">{p}</span>;
      if (/^\{%[\s\S]*%\}$/.test(p)) {
        const inner = p.split(/\b(if|elsif|else|endif|for|in|endfor|and|or|not|assign)\b/g)
          .map((w, j) => /^(if|elsif|else|endif|for|in|endfor|and|or|not|assign)$/.test(w) ? <span key={j} className="kw">{w}</span> : w);
        return <span key={i} className="liq tag">{inner}</span>;
      }
      return <React.Fragment key={i}>{p}</React.Fragment>;
    });
  }

  function CloseIcon() {
    return (
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M3 3l7 7M10 3l-7 7" />
      </svg>
    );
  }

  // ── one transition row ───────────────────────────────────────
  // variant: 'out' | 'in' | 'loop'.  `target` = { label, onClick }
  function FlowRow({ variant, fromLabel, toLabel, label, onClick }) {
    return (
      <button className={'wfd-tr ' + variant} onClick={onClick} type="button">
        <span className="ldot" />
        <span className="ep">
          {fromLabel ? <span>{fromLabel}</span> : null}
          <span className="arr">→</span>
          <span className="tgt">{toLabel}</span>
        </span>
        {label ? <span className="lab">{label}</span> : null}
      </button>
    );
  }

  function WfInspector({ sel, onSelect, onClose }) {
    const [shown, setShown] = useState(false);
    useEffect(() => { const id = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(id); }, []);

    const G = window.WFGraph;
    if (!sel || !G) return null;
    const byId = {};
    G.workflows.forEach((w) => { byId[w.id] = w; });

    const wf = byId[sel.wfId];
    if (!wf) return null;

    const selectWf = (id) => () => onSelect({ type: 'workflow', wfId: id });
    const selectStep = (wfId, stepId) => () => onSelect({ type: 'step', wfId, stepId });

    let body, eyebrow, statusEl, title, sub, kindCls = '';

    if (sel.type === 'workflow') {
      // cross-workflow handoffs out / in, plus same-workflow loop-backs
      const out = [], inb = [], loops = [];
      G.edges.forEach((e) => {
        const f = splitRef(e.from), t = splitRef(e.to);
        if (f.wf === wf.id && t.wf === wf.id) loops.push({ e, f, t });
        else if (f.wf === wf.id) out.push({ e, f, t });
        else if (t.wf === wf.id) inb.push({ e, f, t });
      });

      eyebrow = (<span className="wfd-eyebrow"><span className="dot" />Workflow · {wf.phase}</span>);
      statusEl = (
        <span className={'wfd-status' + (wf.live ? ' live' : '')}>
          {wf.live ? <span className="pulse" /> : null}{wf.statusLabel}
        </span>
      );
      title = <div className="wfd-title">{wf.name}</div>;
      sub = (
        <div className="wfd-sub">
          <span>{wf.steps.length} steps</span><span className="sep">·</span>
          <span>{out.length} out</span><span className="sep">·</span>
          <span>{inb.length} in</span>
          {loops.length ? <><span className="sep">·</span><span>{loops.length} loop-back{loops.length > 1 ? 's' : ''}</span></> : null}
        </div>
      );

      body = (
        <React.Fragment>
          <section className="wfd-sec">
            <div className="wfd-text">{wf.desc}</div>
          </section>

          <section className="wfd-sec">
            <div className="wfd-stats">
              <div className="wfd-stat"><div className="k">phase</div><div className="v sm">{wf.phase}</div></div>
              <div className="wfd-stat"><div className="k">runs · 24h</div><div className="v">{wf.runs24h}</div></div>
              <div className="wfd-stat"><div className="k">avg</div><div className="v sm">{wf.avg}</div></div>
            </div>
          </section>

          <section className="wfd-sec">
            <div className="wfd-lbl">Steps <span className="n">{wf.steps.length}</span></div>
            <div className="wfd-steps">
              {wf.steps.map((s, i) => (
                <button key={s.id} className={'wfd-step ' + KIND_CLASS(s.kind)} onClick={selectStep(wf.id, s.id)} type="button">
                  <span className="num">{i + 1}</span>
                  <span className="nm">{s.name}</span>
                  <span className="kd">{s.kind === 'final' ? 'final' : s.kind}</span>
                  <span className="arr">›</span>
                </button>
              ))}
            </div>
          </section>

          {loops.length ? (
            <section className="wfd-sec">
              <div className="wfd-lbl">Loop-backs <span className="n">{loops.length}</span></div>
              <div className="wfd-flow">
                {loops.map(({ e, f, t }) => (
                  <FlowRow key={e.from + e.to} variant="loop"
                    fromLabel={f.step} toLabel={t.step} label={e.label}
                    onClick={selectStep(wf.id, t.step)} />
                ))}
              </div>
            </section>
          ) : null}

          <section className="wfd-sec">
            <div className="wfd-lbl">Routes out <span className="n">{out.length}</span></div>
            {out.length ? (
              <div className="wfd-flow">
                {out.map(({ e, f, t }) => (
                  <FlowRow key={e.from + e.to} variant="out"
                    fromLabel={f.step} toLabel={(byId[t.wf] ? byId[t.wf].name : t.wf)} label={e.label}
                    onClick={selectWf(t.wf)} />
                ))}
              </div>
            ) : <div className="wfd-empty">terminal — no outgoing routes</div>}
          </section>

          <section className="wfd-sec">
            <div className="wfd-lbl">Routes in <span className="n">{inb.length}</span></div>
            {inb.length ? (
              <div className="wfd-flow">
                {inb.map(({ e, f, t }) => (
                  <FlowRow key={e.from + e.to} variant="in"
                    fromLabel={(byId[f.wf] ? byId[f.wf].name : f.wf)} toLabel={t.step} label={e.label}
                    onClick={selectWf(f.wf)} />
                ))}
              </div>
            ) : <div className="wfd-empty">no inbound routes</div>}
          </section>
        </React.Fragment>
      );
    } else {
      // ── step ──
      const idx = wf.steps.findIndex((s) => s.id === sel.stepId);
      const step = wf.steps[idx];
      if (!step) return null;
      kindCls = KIND_CLASS(step.kind);

      const cfg = (G.stepLib && G.stepLib[step.id]) || {};
      const ts = stamps(wf.id + '.' + step.id);
      const isFinal = step.kind === 'final';

      const ref = wf.id + '.' + step.id;
      const explicit = [];
      G.edges.forEach((e) => {
        const f = splitRef(e.from), t = splitRef(e.to);
        if (e.from === ref) explicit.push({ e, t, loop: t.wf === wf.id });
      });
      const next = idx < wf.steps.length - 1 ? wf.steps[idx + 1] : null;
      // transitions = the implicit forward step (if any) + every explicit edge out
      const trans = [];
      if (next) trans.push({ key: 'next', label: next.name, onClick: selectStep(wf.id, next.id), loop: false });
      explicit.forEach(({ e, t, loop }) => trans.push({
        key: e.from + e.to,
        label: loop ? t.step : (byId[t.wf] ? byId[t.wf].name : t.wf),
        onClick: loop ? selectStep(wf.id, t.step) : selectWf(t.wf),
        loop,
      }));

      eyebrow = (<span className="wfd-eyebrow">Step Configuration</span>);
      statusEl = null;
      title = (
        <div className="wfd-step-id">
          <span className={'wfd-num ' + kindCls}>{idx + 1}</span>
          <div className="wfd-step-name">
            <div className="wfd-title mono">{step.name}</div>
            <div className="wfd-hash">{shortId(ref)}</div>
          </div>
        </div>
      );
      sub = null;

      body = (
        <React.Fragment>
          <section className="wfd-sec">
            <div className="wfd-lbl">Goal</div>
            {cfg.goal ? <div className="wfd-text">{cfg.goal}</div> : <div className="wfd-placeholder">No goal set</div>}
          </section>

          <section className="wfd-sec">
            <div className="wfd-lbl">Prompt</div>
            {cfg.prompt ? <pre className="wfd-prompt">{highlightPrompt(cfg.prompt)}</pre> : <div className="wfd-placeholder">No prompt</div>}
          </section>

          <section className="wfd-sec">
            <div className="wfd-lbl">Overview</div>
            <div className="wfd-rows">
              <div className="wfd-row"><span className="rk">Type</span><span className={'wfd-tag ' + kindCls}>{isFinal ? 'final' : step.kind}</span></div>
              <div className="wfd-row"><span className="rk">Order</span><span className="wfd-pill">{idx}</span></div>
              <div className="wfd-row"><span className="rk">Final step</span><span className={'wfd-toggle' + (isFinal ? ' on' : '')}><span className="knob" /></span></div>
            </div>
          </section>

          <section className="wfd-sec">
            <div className="wfd-lbl">Agents <span className="n">{(cfg.agents || []).length}</span></div>
            {(cfg.agents || []).length
              ? <div className="wfd-chiprow">{cfg.agents.map((a) => <span key={a} className="wfd-chip">{a}</span>)}</div>
              : <div className="wfd-placeholder">No agents</div>}
          </section>

          <section className="wfd-sec">
            <div className="wfd-lbl">Skills <span className="n">{(cfg.skills || []).length}</span></div>
            {(cfg.skills || []).length
              ? <div className="wfd-chiprow">{cfg.skills.map((sk) => <span key={sk} className="wfd-chip">{sk}</span>)}</div>
              : <div className="wfd-placeholder">No skills</div>}
          </section>

          <section className="wfd-sec">
            <div className="wfd-lbl">Transitions <span className="n">{trans.length}</span></div>
            {trans.length
              ? <div className="wfd-chiprow">{trans.map((tr) => (
                  <button key={tr.key} className={'wfd-trans' + (tr.loop ? ' loop' : '')} onClick={tr.onClick} type="button">
                    <span className="arr">→</span>{tr.label}
                  </button>
                ))}</div>
              : <div className="wfd-placeholder">Terminal — no transitions</div>}
          </section>

          <section className="wfd-sec">
            <div className="wfd-lbl">Model</div>
            <div className="wfd-row"><span className="rk">Primary</span>{cfg.model ? <span className="wfd-pill">{cfg.model}</span> : <span className="wfd-placeholder">none</span>}</div>
          </section>

          <section className="wfd-sec">
            <div className="wfd-lbl">Timeline</div>
            <div className="wfd-rows">
              <div className="wfd-row"><span className="rk">Created</span><span className="rv">{ts.created}</span></div>
              <div className="wfd-row"><span className="rk">Updated</span><span className="rv">{ts.updated}</span></div>
            </div>
          </section>
        </React.Fragment>
      );
    }

    return (
      <div className={'wfd ' + kindCls + (kindCls ? ' kindspine' : '') + (shown ? ' shown' : '')} data-no-pan>
        <div className="wfd-hd">
          <div className="wfd-hd-top">
            {eyebrow}
            {statusEl}
            <button className="wfd-close" onClick={onClose} title="Close (Esc)" type="button"><CloseIcon /></button>
          </div>
          {title}
          {sub}
        </div>
        <div className="wfd-body">{body}</div>
      </div>
    );
  }

  window.WfInspector = WfInspector;
})();
