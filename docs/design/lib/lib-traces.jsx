/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Traces
   FlightStrip · EventCard (step · agent · tool · wait · error)
   ────────────────────────────────────────────────────────────────── */
(function () {
  // ── FlightStrip ─────────────────────────────────────────────
  // { steps:[{kind,left,width,live}], tools:[{left,error}], turns:[left],
  //   viewport:{left,width}, play:left, ticks:[label] }
  function FlightStrip({ steps = [], tools = [], turns = [], viewport, play, ticks = [] }) {
    return (
      <div className="flight-strip">
        <div className="lane l1"><span className="lane-label">Steps</span></div>
        <div className="lane l2"><span className="lane-label">Tools</span></div>
        <div className="lane l3"><span className="lane-label">Turns</span></div>

        {steps.map((s, i) => (
          <div key={'s' + i} className={'mk kind-' + s.kind + (s.live ? ' live' : '')}
            style={{ left: s.left, width: s.width, top: 4 }} />
        ))}
        {tools.map((t, i) => (
          <div key={'t' + i} className={'pip ' + (t.error ? 'error' : 'tool')} style={{ left: t.left, top: 33 }} />
        ))}
        {turns.map((left, i) => (
          <div key={'u' + i} className="pip agent" style={{ left, top: 55 }} />
        ))}
        {viewport ? <div className="vp" style={{ left: viewport.left, width: viewport.width }} /> : null}
        {play ? <div className="play" style={{ left: play }} /> : null}
        <div className="ruler">
          {ticks.map((t, i) => <div key={i} className="tick">{t}</div>)}
        </div>
      </div>
    );
  }

  // ── EventCard ───────────────────────────────────────────────
  // Discriminated by `type`: step | agent | tool | wait | error
  function EventWhen({ at, rel, id }) {
    return (
      <div className="when">
        {at}<span className="rel">{rel}</span>
        {id ? <window.IdChip id={id} /> : null}
      </div>
    );
  }

  function StepEvent({ at, rel, pre, to, kind, selected, onClick }) {
    return (
      <div className={'event step kind-' + kind + (selected ? ' sel' : '')} onClick={onClick}>
        <EventWhen at={at} rel={rel} />
        <div className="body">
          {pre ? <span className="pre">{pre}</span> : null}
          <span className="arr">→</span>
          <span className="to">{to}</span>
          <span className="tag">{kind}</span>
        </div>
      </div>
    );
  }

  function AgentEvent({ at, rel, id, speaker, model, prose, selected, onClick }) {
    return (
      <div className={'event agent' + (selected ? ' sel' : '')} onClick={onClick}>
        <EventWhen at={at} rel={rel} id={id} />
        <div className="body">
          <div className="speaker">{speaker}{model ? <span className="model">{model}</span> : null}</div>
          <div className="prose">{prose}</div>
        </div>
      </div>
    );
  }

  // cmd parts: { prompt, cmd, flag, em, dur }
  function ToolEvent({ at, rel, error, prompt = '$', cmd, flag, em, dur, selected, onClick }) {
    return (
      <div className={'event tool' + (error ? ' err' : '') + (selected ? ' sel' : '')} onClick={onClick}>
        <EventWhen at={at} rel={rel} />
        <div className="body">
          <span className="sd" />
          <span className="prompt">{prompt}</span>
          {cmd}{flag ? <span className="flag"> {flag}</span> : null} {em ? <em>{em}</em> : null}
          {dur ? <span className="dur">{dur}</span> : null}
        </div>
      </div>
    );
  }

  function WaitEvent({ at, rel, id, text, wid, selected, onClick }) {
    return (
      <div className={'event wait' + (selected ? ' sel' : '')} onClick={onClick}>
        <EventWhen at={at} rel={rel} id={id} />
        <div className="body">
          <span>{text}</span>
          <span className="flow" />
          {wid ? <span className="wid">{wid}</span> : null}
        </div>
      </div>
    );
  }

  function ErrorEvent({ at, rel, id, title, sub, selected, onClick }) {
    return (
      <div className={'event error' + (selected ? ' sel' : '')} onClick={onClick}>
        <EventWhen at={at} rel={rel} id={id} />
        <div className="body">
          <b>{title}</b>
          {sub ? <span className="sub">{sub}</span> : null}
        </div>
      </div>
    );
  }

  // Dispatcher — `type` ∈ step | agent | tool | wait | error
  function EventCard(props) {
    switch (props.type) {
      case 'agent': return <AgentEvent {...props} />;
      case 'tool': return <ToolEvent {...props} />;
      case 'wait': return <WaitEvent {...props} />;
      case 'error': return <ErrorEvent {...props} />;
      case 'step':
      default: return <StepEvent {...props} />;
    }
  }

  Object.assign(window, {
    FlightStrip, EventCard, StepEvent, AgentEvent, ToolEvent, WaitEvent, ErrorEvent,
  });
})();
