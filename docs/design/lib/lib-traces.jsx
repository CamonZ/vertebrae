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
  // The event stream is now rendered by the shared <EventRow> atom
  // (lib-eventlog.jsx) — chat thread + Traces stream are one log, one
  // visual language. EventCard is kept as a back-compat alias that
  // delegates to EventRow. Traces wraps the stream in <EventLog mode="timed">
  // so the time/rel/id gutter shows; chat uses mode="bare".
  function EventCard(props) {
    const EventRow = window.EventRow;
    if (!EventRow) return null;
    return <EventRow {...props} />;
  }

  Object.assign(window, { FlightStrip, EventCard });
})();
