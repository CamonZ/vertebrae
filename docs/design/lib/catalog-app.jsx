/* ──────────────────────────────────────────────────────────────────
   Hearth · Components v2 — IMPLEMENTED catalog
   Renders the real React components (loaded from lib-*.jsx) in the same
   card vocabulary as the spec page (components-v2.html).
   ────────────────────────────────────────────────────────────────── */
(function () {
  const {
    RunChip, IdChip, KindChip, Pipeline, StepDot, StateBreakdown, Glyph,
    TaskRow, BoardCard, RunCard, WorkflowRailItem, RecentItem,
    DetailHeader, HeroStatus, Accordion, FieldRow,
    StepNode, GraphEdge, RunPellet, Minimap, ZoomWidget,
    FlightStrip, EventCard,
    Button, IconButton, SearchBar, ViewTabs, OverlayToggle, AutoScrollSwitch,
    ScopeRow, LevelSelect, TopBar, SideRail,
    TypeRamp, SurfaceRamp, InkRamp, AccentRamp, TokenTriplet, SpacingScale,
    IndentGuide, LayoutDiagram, AppFrame, FlowEdge, WaitBar,
  } = window;

  // ── Layout helpers ──────────────────────────────────────────
  function Section({ num, name, title, lede, children }) {
    return (
      <section className="sect" id={name} data-screen-label={num}>
        <div className="sect-num">§ {num} · {name}</div>
        <h2>{title}</h2>
        {lede ? <p className="lede">{lede}</p> : null}
        {children}
      </section>
    );
  }

  function Card({ name, em, desc, canvas, canvasClass, canvasStyle, foot }) {
    return (
      <div className="card">
        <div className="card-head"><div className="card-name">{name}{em ? <em>· {em}</em> : null}</div></div>
        {desc ? <div className="card-desc">{desc}</div> : null}
        <div className={'card-canvas' + (canvasClass ? ' ' + canvasClass : '')} style={canvasStyle}>{canvas}</div>
        {foot ? <div className="card-foot">{foot}</div> : null}
      </div>
    );
  }

  const Rule = ({ children }) => <span className="rule">{children}</span>;

  const SubHead = ({ children, em, mt }) => (
    <h3 style={{ fontFamily: 'var(--serif)', fontSize: 22, fontStyle: 'italic', fontWeight: 400, color: 'var(--fg)', letterSpacing: '-0.01em', margin: (mt ? 'var(--s-7)' : 'var(--s-6)') + ' 0 var(--s-3)', lineHeight: 1.15 }}>
      {children}{em ? <em style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-faint)', fontStyle: 'normal', letterSpacing: '0.06em', marginLeft: 8 }}>{em}</em> : null}
    </h3>
  );

  // ════════════════════════════════════════════════════════════
  //  1 · FOUNDATIONS
  // ════════════════════════════════════════════════════════════
  function Foundations() {
    return (
      <Section num="01" name="foundations" title="Foundations."
        lede="Type, color, and space. Every component composes from these three sources and breaks no rule of them.">
        <SubHead>Type ramp</SubHead>
        <TypeRamp />

        <SubHead em="warm neutrals" mt>Surfaces &amp; ink</SubHead>
        <div className="grid two">
          <Card name="Backgrounds" canvasStyle={{ padding: 0, gap: 0 }} canvas={<SurfaceRamp />}
            foot={<>5-step warm dark ramp. <Rule>bg-1 cards · bg-2 nested · bg-3 selected · bg-4 highest.</Rule></>} />
          <Card name="Ink" canvasStyle={{ padding: 0, gap: 0 }} canvas={<InkRamp />}
            foot={<>5-step warm neutral ramp. <Rule>fg primary · fg-mute secondary · fg-faint metadata · fg-ghost separators.</Rule></>} />
        </div>

        <SubHead em="the accent · hue 40°" mt>Hearthfire</SubHead>
        <div className="card">
          <div className="card-canvas" style={{ padding: 'var(--s-3)', gap: 'var(--s-3)', alignItems: 'stretch' }}><AccentRamp /></div>
          <div className="card-foot"><b>--accent-glow</b> for box-shadows on running things. <Rule>accent-deep / accent-mute exist for state changes only. Never as decoration.</Rule></div>
        </div>

        <SubHead em="semantic anchors" mt>Status</SubHead>
        <p className="lede" style={{ fontSize: 14, marginBottom: 'var(--s-3)' }}>Four colors fixed by universal meaning — red, green, yellow, blue. Each derives a main / wash / fg family.</p>
        <div className="grid">
          <TokenTriplet base="ok" fg="ok" hue={145} note="status" anchored />
          <TokenTriplet base="warn" fg="warn" hue={75} note="status" anchored />
          <TokenTriplet base="err" fg="err" hue={25} note="status" anchored />
          <TokenTriplet base="info" fg="info" hue={220} note="status" anchored />
        </div>

        <SubHead em="workflow position" mt>Step kinds</SubHead>
        <p className="lede" style={{ fontSize: 14, marginBottom: 'var(--s-3)' }}>Five hues, each ≥30° from its neighbors — chosen for perceptual distinctness.</p>
        <div className="grid">
          <TokenTriplet base="step-execute" fg="step-execute-fg" hue={285} note="execute" />
          <TokenTriplet base="step-eval" fg="step-eval-fg" hue={200} note="eval" />
          <TokenTriplet base="step-route" fg="step-route-fg" hue={135} note="route" />
          <TokenTriplet base="step-human" fg="step-human-fg" hue={70} note="human" />
          <TokenTriplet base="step-wait" fg="step-wait-fg" hue={250} note="wait" />
        </div>

        <SubHead em="the 4px base scale" mt>Spacing</SubHead>
        <div className="grid two">
          <Card name="Spacing scale" em="--s-*" canvasClass="col start" canvasStyle={{ padding: 'var(--s-4)', gap: 0 }}
            canvas={<SpacingScale />}
            foot={<><b>Base 4px.</b> Steps run 4 → 28 by fours, then skip (32 → 40 → 48 → 64). <Rule>No raw pixel values in components.</Rule></>} />
          <Card name="Text rhythm" em="measured margins" canvasClass="col start" canvasStyle={{ padding: 'var(--s-4)', gap: 0, alignItems: 'stretch' }}
            canvas={<>
              <div className="t-h1" style={{ lineHeight: 1.15 }}>Workflow pipelines</div>
              <div style={{ height: 12 }} />
              <div className="t-body" style={{ color: 'var(--fg-mute)' }}>A lede sets up the section in one warm sentence.</div>
              <div style={{ height: 20 }} />
              <div className="t-body">First paragraph of running body copy at the 13px base size.</div>
              <div style={{ height: 12 }} />
              <div className="t-body">Second paragraph — the gap is fixed at --s-3.</div>
            </>}
            foot={<><b>h3</b> 24/12px · <b>.lede</b> 20px · <b>p</b> 12px. <Rule>Rhythm is fixed so vertical spacing never gets eyeballed.</Rule></>} />
        </div>

        <div className="ember-callout"><em>Ember rule.</em> The accent is reserved for one thing: <em>now</em>. Running tasks, the live segment of a workflow, the selected row. Nothing else takes the ember.</div>
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  2 · PRIMITIVES
  // ════════════════════════════════════════════════════════════
  function Primitives() {
    return (
      <Section num="02" name="primitives" title="Chip primitives."
        lede="Three small pieces of metal that name everything. RunChip says what work is doing. IdChip is how IDs travel. KindChip names a step's position in a workflow.">
        <div className="grid wide">
          <Card name="RunChip" em="runtime state"
            desc="One chip per row, ever. Carries state class + optional runtime suffix. Hidden entirely for terminal/null states."
            canvas={<>
              <RunChip state="running" label="Running" runtime="2m" />
              <RunChip state="waiting" label="Waiting" runtime="7h 36m" />
              <RunChip state="queued" label="Queued" />
              <RunChip state="completed" label="Completed" force />
              <RunChip state="failed" label="Failed" />
            </>}
            foot={<><b>Variants:</b> running · waiting · queued · completed · failed · cancelled · stopped. <b>Sizes:</b> default, sm.<br /><Rule>Rule — for terminal states and null, render nothing (the <code style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>force</code> prop overrides for this catalog).</Rule></>} />

          <Card name="IdChip" em="copyable identity"
            desc="Every ID is one of these — never bare text. Hover reveals copy glyph, click flashes green ✓. Try clicking one."
            canvas={<><IdChip id="40628099" /><IdChip id="c794b783" /><IdChip id="t1.codex" /><IdChip id="wait.c794" /></>}
            foot={<><b>States:</b> rest · hover · pressed · copied. <Rule>Rule — every ID in the system is rendered as IdChip. No exceptions.</Rule></>} />

          <Card name="KindChip" em="workflow position"
            desc="Names the kind of step. Always paired with its hue swatch so the palette is reinforced everywhere the chip appears."
            canvas={<><KindChip kind="execute" /><KindChip kind="eval" /><KindChip kind="route" /><KindChip kind="human" /><KindChip kind="wait" /></>}
            foot={<><b>Used in:</b> step-detail header · field rows · step transition events.</>} />
        </div>
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  3 · HIERARCHY
  // ════════════════════════════════════════════════════════════
  function Hierarchy() {
    return (
      <Section num="03" name="hierarchy" title="Hierarchy."
        lede="Epic, ticket, task. Three glyphs, three type weights, one indent system. Read at a glance — you never count levels.">
        <div className="grid two">
          <Card name="Glyphs &amp; level type ramp"
            desc="Shared grammar across three levels: glyph · title · right (chip · when). Epic in serif italic, ticket sans 500, task sans 400."
            canvasClass="col start"
            canvas={<div style={{ width: '100%' }}>
              <TaskRow level={0} title="Vertebrae Web App" when="Apr 25" run={{ state: 'running', label: 'Running' }} />
              <TaskRow level={1} title="Explore backend chat sessions" when="18d" run={{ state: 'running', label: 'Running', sm: true }} />
              <TaskRow level={2} title="Hydrate chat runner state and resume pending work" when="2m" run={{ state: 'running', label: '2m', sm: true }} />
            </div>}
            foot={<><b>Glyph map:</b> ◈ epic · ◇ ticket · · task. <Rule>Rule — glyph + type ramp carry hierarchy. Indentation is reinforcement, not the signal.</Rule></>} />

          <Card name="IndentGuide"
            desc="A 1px dashed vertical inside the row's left margin. Renders only when the row is indented under an open parent — never on roots or collapsed branches."
            canvasClass="col start"
            canvas={<IndentGuide />}
            foot={<><b>Usage:</b> tasks list, traces task rail. <Rule>Rule — guides on the rendered tree, never as filler on flat lists.</Rule></>} />
        </div>
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  4 · COMPOUND STATE
  // ════════════════════════════════════════════════════════════
  function Compound() {
    const kinds = ['execute', 'eval', 'route', 'human', 'wait'];
    const states = ['completed', 'running', 'waiting', 'queued'];
    return (
      <Section num="04" name="compound" title="Compound state."
        lede="Where kind meets state. Each segment is hued by stepKind and brightened by runState. The system's most expressive widget.">
        <div className="grid wide">
          <Card name="Pipeline strip"
            desc="Compact horizontal segments. Kind = hue, state = opacity + glow. Five kinds × four states = the entire vocabulary in a 4px ribbon."
            canvasClass="col start" canvasStyle={{ padding: 'var(--s-4)' }}
            canvas={<>
              <table style={{ borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-faint)', width: '100%' }}>
                <tbody>
                  <tr><td></td>{states.map(s => <td key={s} style={{ padding: '4px 8px', textAlign: 'center' }}>{s}</td>)}</tr>
                  {kinds.map(k => (
                    <tr key={k}>
                      <td style={{ padding: '6px 8px', textAlign: 'right', color: 'var(--fg-mute)' }}>{k}</td>
                      {states.map(s => (
                        <td key={s} style={{ padding: '6px 8px' }}>
                          <Pipeline width={60} height={6} segments={[{ kind: k, state: s }]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: 'var(--s-4)', width: '100%' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-faint)', marginBottom: 6 }}>Example — running ticket's workflow:</div>
                <Pipeline width={200} height={8} segments={[
                  { kind: 'execute', state: 'completed' }, { kind: 'execute', state: 'completed' },
                  { kind: 'execute', state: 'completed' }, { kind: 'execute', state: 'running' },
                  { kind: 'eval', state: 'queued' }, { kind: 'human', state: 'queued' }, { kind: 'wait', state: 'queued' },
                ]} />
              </div>
            </>}
            foot={<><b>Used in:</b> task row meta · board card · workflow rail item · flight strip. <Rule>Rule — never label segments with text. The hue + state IS the legend.</Rule></>} />

          <Card name="StepDot"
            desc="Pellet form of the pipeline. Used in hero status dots, minimaps, child summaries. Same encoding; circle silhouette."
            canvas={<><StepDot variant="done" /><StepDot variant="done" /><StepDot variant="running" /><StepDot variant="waiting" /><StepDot variant="queued" /><StepDot variant="queued" /></>}
            foot={<><b>Variants:</b> done (✓), running (ember pulse), waiting (warn), queued (outline). <Rule>No connecting lines — the graph engine can loop.</Rule></>} />

          <Card name="StateBreakdown"
            desc="The replacement for linear &ldquo;X of Y&rdquo;. Workflows are graphs that can loop; show per-state counts instead."
            canvas={<StateBreakdown done={4} running={1} waiting={1} queued={2} />}
            foot={<><b>Glyphs:</b> ✓ done · ▶ running · ⏸ waiting · ○ queued. <Rule>Rule — only render counts &gt; 0.</Rule></>} />
        </div>
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  5 · LAYOUT DIAGRAMS
  // ════════════════════════════════════════════════════════════
  function Layouts() {
    return (
      <Section num="05" name="layouts" title="Page layouts."
        lede="How the components compose into each surface. Annotated wireframes for the four canonical views — each a shell + a unique center + an optional inspector.">
        <SubHead em="tasks-v2.html">Tasks</SubHead>
        <LayoutDiagram variant="tasks" stub="TASKS"
          regions={[
            { name: 'Side rail', comps: 'SideRail<br>(44px)' },
            { name: 'List column', accent: true, comps: 'ScopeRow + SearchBar<br>TaskRow × N<br>(Epic ◈ / Ticket ◇ / Task ·)<br>IndentGuide' },
            { name: 'Detail panel', comps: 'DetailHeader · IdChip · Actions<br>HeroStatus<br>Accordion: Children<br>Accordion: Spec / Deps / Code<br>TracesLink' },
          ]}
          annot='<b>Selection model:</b> click a row → detail panel updates. ↑/↓ navigate · ←/→ collapse-or-jump · Esc deselects. <b>The detail panel is always-on</b> — Tasks is a single-focus surface.' />

        <SubHead em="board-v2.html" mt>Board</SubHead>
        <LayoutDiagram variant="board" stub="BOARD"
          regions={[
            { name: 'Side rail', comps: 'SideRail' },
            { name: 'Queued', comps: 'BoardCard × N<br>+ NewTaskStub' },
            { name: 'Running', accent: true, comps: 'BoardCard.running<br>(ember left)' },
            { name: 'Waiting', comps: 'BoardCard.waiting' },
            { name: 'Done', comps: 'BoardCard.done<br>(no chip, dimmed)' },
          ]}
          annot='<b>Columns = runState</b>, not workflow stage. <b>Card kind</b> shows on the top edge (stepKind hue). Click a card → tasks-v2.html#&lt;id&gt;.' />

        <SubHead em="design-v2.html" mt>Design</SubHead>
        <LayoutDiagram variant="design" stub="DESIGN · workflows"
          regions={[
            { name: 'Side rail', className: 'reg-side' },
            { name: 'Workflow catalog', className: 'reg-list', comps: 'SearchBar<br>WorkflowRailItem × 10<br>(name · shape · meta)' },
            { name: 'Graph canvas', accent: true, className: 'reg-canvas', comps: 'StepNode × N (positioned)<br>GraphEdge + .live<br>OverlayToggle (header)<br>ZoomWidget + Minimap' },
            { name: 'Inspector', className: 'reg-insp', comps: 'Step title<br>KindChip<br>Contract prose<br>Stats fields' },
            { name: 'Active runs strip', className: 'reg-strip', comps: 'RunCard × N · "at step N · kind"' },
          ]}
          annot='<b>The graph IS the workflow definition; the runtime is an overlay.</b> The inspector slides in when a node is clicked. Bottom strip shows live runs through this workflow.' />

        <SubHead em="traces-v2.html" mt>Traces</SubHead>
        <LayoutDiagram variant="traces" stub="TRACES"
          regions={[
            { name: 'Side rail', className: 'reg-side' },
            { name: 'Tasks tree', className: 'reg-tasks', comps: 'TaskRow × N · IdChip' },
            { name: 'Runs', className: 'reg-runs', comps: 'RunCard × N<br>(waiting · failed · completed)' },
            { name: 'Trace center', accent: true, className: 'reg-center', comps: 'DetailHeader · IdChip · HeroStatus<br>FlightStrip (Steps · Tools · Turns)<br>ScopeRow + SearchBar (filters)<br>EventStream — Step / Agent / Tool / Wait / Error' },
          ]}
          annot='<b>Rail does double duty:</b> top half = task tree, bottom half = runs of that task. The selected run gets the ember edge. <b>FlightStrip</b> sits above the events, driving the auto-scroll viewport.' />
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  7 · ROWS & CARDS
  // ════════════════════════════════════════════════════════════
  function Rows() {
    const [selected, setSelected] = React.useState('40628099');
    const [view, setView] = React.useState('list');
    return (
      <Section num="07" name="rows" title="Rows &amp; cards."
        lede="Where the vocabulary lives day-to-day. Same chips, same hues, across list rows, board cards, run cards, and workflow rail items. Click a row to select it.">
        <div className="grid wide">
          <Card name="TaskRow"
            desc="The tasks-v2 list row. Three level styles, shared grammar: glyph · title · right (chip · id · when)."
            canvasClass="col start" canvasStyle={{ padding: 'var(--s-3)' }}
            canvas={<div style={{ width: '100%' }}>
              <TaskRow level={0} title="Vertebrae Web App" id="2b064abb" when="Apr 25"
                run={{ state: 'running', label: 'Running' }}
                selected={selected === '2b064abb'} onClick={() => setSelected('2b064abb')} />
              <TaskRow level={1} title="Emit chat runner activity events" id="40628099" when="11h"
                run={{ state: 'waiting', label: 'Waiting', runtime: '7h 36m' }}
                selected={selected === '40628099'} onClick={() => setSelected('40628099')} />
              <TaskRow level={2} title="Hydrate chat runner state and resume pending work" id="c794b783" when="2m"
                run={{ state: 'running', label: '2m', sm: true }}
                selected={selected === 'c794b783'} onClick={() => setSelected('c794b783')} />
              <TaskRow level={2} title="Define client-safe activity event builders" id="80e1a7b6" when="7h" completed
                selected={selected === '80e1a7b6'} onClick={() => setSelected('80e1a7b6')} />
            </div>}
            foot={<><b>Selected row:</b> accent-wash bg + ember left stripe. <b>Completed:</b> no chip, title in fg-mute. <Rule>Rule — never two chips per row.</Rule></>} />

          <Card name="BoardCard"
            desc="Vertical card for the kanban surface. Top-edge hue = stepKind. Running gets the ember left edge + accent-wash gradient."
            canvasStyle={{ padding: 'var(--s-3)', alignItems: 'stretch' }}
            canvas={<div style={{ display: 'flex', gap: 10, width: '100%' }}>
              <div style={{ flex: 1 }}>
                <BoardCard kind="execute" title="Stream live chat responses" stepLabel="execute"
                  run={{ state: 'queued', label: 'Queued' }} id="0ac78100" when="13d" />
              </div>
              <div style={{ flex: 1 }}>
                <BoardCard kind="wait" title="Emit chat runner activity events" stepLabel="wait" running
                  run={{ state: 'waiting', label: 'Waiting · 7h 36m' }} id="40628099" when="11h" />
              </div>
            </div>}
            foot={<><b>Variants:</b> queued · running (ember) · waiting · done (dimmed). <Rule>Rule — top edge hue = stepKind. Ember = runState. Never conflate.</Rule></>} />

          <Card name="RunCard"
            desc="Compact card representing a single attempt of a task. Used in traces rail and design-v2 active-runs strip."
            canvas={<>
              <RunCard run={{ state: 'waiting', label: 'Waiting', runtime: '7h 36m' }} id="43abee9d" when="started 01:13 AM" selected />
              <RunCard run={{ state: 'failed', label: 'Failed' }} id="6b2f5482" when="started 01:05 AM" reason="tool timeout" />
            </>}
            foot={<><b>Selected run</b> gets ember left edge. <b>Failed</b> shows reason inline.</>} />

          <Card name="WorkflowRailItem"
            desc="A workflow entry in the design-v2 left rail. Title in serif italic, shape mini-strip below, live + 24h stats in mono."
            canvas={<>
              <WorkflowRailItem name="Chat Runner Lifecycle" selected live={1} steps={7} daily={10}
                shape={['execute', 'eval', 'route', 'execute', 'wait', 'execute', 'terminal']} />
              <WorkflowRailItem name="Authoring · Verifier Gate" steps={5} daily={14} avg="1m 38s"
                shape={['execute', 'eval', 'human', 'execute', 'terminal']} />
            </>}
            foot={<><b>Shape strip</b> summarizes step kinds in order. <b>Live count</b> only appears when &gt; 0.</>} />
        </div>
        <div style={{ marginTop: 'var(--s-4)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--fg-faint)' }}>selected:</span>
          <IdChip id={selected} />
          <span style={{ marginLeft: 'auto' }}><ViewTabs value={view} onChange={setView} tabs={[
            { id: 'list', label: 'List', icon: 'list' }, { id: 'board', label: 'Board', icon: 'board' },
          ]} /></span>
        </div>
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  4 · DETAIL
  // ════════════════════════════════════════════════════════════
  function Detail() {
    return (
      <Section num="08" name="detail" title="Detail panel."
        lede="The composable focus surface. Header + hero status + accordion sections + field rows. Click an accordion header to toggle.">
        <div className="grid">
          <Card name="DetailHeader"
            desc="Title (serif italic, optional accent emphasis on a noun phrase) · IdChip · breadcrumb."
            canvasClass="col start" canvasStyle={{ padding: 'var(--s-3)' }}
            canvas={<DetailHeader
              title="Emit chat runner activity events and replace single-shot live chat runner lifecycle"
              mark="live chat runner" id="40628099"
              crumbs={[{ text: 'ticket' }, { text: 'under Vertebrae Web App', em: false }]} />}
            foot={<><b>Selective emphasis</b> on a noun via accent. <Rule>Use sparingly — one emphasized phrase per title.</Rule></>} />

          <Card name="HeroStatus"
            desc="The &ldquo;what is happening right now&rdquo; pill. State-colored left border, run state label, runtime, step pointer."
            canvasClass="col start" canvasStyle={{ padding: 'var(--s-3)' }}
            canvas={<>
              <HeroStatus state="waiting" edge="wait" label="Waiting · for children" runtime="7h 36m running" step={{ n: 5, kind: 'wait' }} />
              <HeroStatus state="running" edge="execute" label="Running" runtime="2m" step={{ n: 4, kind: 'execute' }} />
              <HeroStatus state="completed" edge="ok" label="Completed" finished="completed 11h ago" />
            </>}
            foot={<><b>State-driven layout:</b> waiting shows runtime + step, completed shows finish time. Edge color = stepKind.</>} />

          <Card name="Accordion + FieldRow"
            desc="Collapsible section pattern for the detail body. Headers carry name + count. Inside, FieldRow for compact attribute lists."
            canvasClass="col start" canvasStyle={{ padding: 'var(--s-3)' }}
            canvas={<>
              <Accordion name="Children" accent count={6} defaultOpen={false} />
              <Accordion name="Details" defaultOpen>
                <FieldRow k="Step kind" v="wait" tone="serif wait" />
                <FieldRow k="Priority" v="High ↑" tone="err" />
                <FieldRow k="Updated" v="11h ago" />
              </Accordion>
            </>}
            foot={<><b>Default state:</b> Children open · others collapsed. <b>Counts</b> only when meaningful.</>} />

          <Card name="RecentItem"
            desc="A single line in a &ldquo;recent runs&rdquo; or &ldquo;children&rdquo; list. Dot + name + time."
            canvasClass="col start" canvasStyle={{ padding: 'var(--s-3)' }}
            canvas={<>
              <RecentItem variant="running" title="Emit chat runner activity events" when="7h 36m" />
              <RecentItem variant="done" muted title="Stream live chat — turn 184" when="2m" />
              <RecentItem variant="done" muted title="Drive authoring intents — verifier pass" when="11m" />
            </>}
            foot={<><b>Dot variants:</b> done · running (ember pulse) · waiting (warn).</>} />
        </div>
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  5 · GRAPH
  // ════════════════════════════════════════════════════════════
  function Graph() {
    return (
      <Section num="09" name="graph" title="Workflow graph."
        lede="The design-v2 surface. Step nodes hued by kind, edges plain or live (animated accent), and a minimap that mirrors the palette.">
        <div className="grid">
          <Card name="StepNode"
            desc="A workflow definition's vertex. 2px top edge in kind hue · num badge · kind label · title · optional runs-row + pellets when active."
            canvas={<>
              <StepNode num={1} kind="execute" title="accept_user_turn" />
              <StepNode num={5} kind="wait" title="wait_for_children" active runs="1 running · 7h 36m">
                <div style={{ display: 'flex', gap: 4, marginTop: 6 }}><RunPellet id="c794b783" /></div>
              </StepNode>
            </>}
            foot={<><b>Active state</b> gets the ember treatment. <Rule>Rule — never colour the node body by kind. Hue lives on the top edge.</Rule></>} />

          <Card name="GraphEdge"
            desc="SVG bezier between node anchors. Variants: neutral (line-strong) and live (animated dashed accent with glow)."
            canvasStyle={{ minHeight: 140 }}
            canvas={<svg width="100%" height="120" viewBox="0 0 320 120">
              <defs>
                <marker id="ar1" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="var(--line-strong)" /></marker>
              </defs>
              <GraphEdge d="M30,40 C90,40 110,40 150,40" markerEnd="url(#ar1)" />
              <text x="22" y="34" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-faint)">A</text>
              <text x="155" y="34" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-faint)">B</text>
              <text x="90" y="58" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-faint)" textAnchor="middle">neutral</text>
              <GraphEdge d="M30,90 C90,90 110,90 150,90" live />
              <text x="22" y="84" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-faint)">A</text>
              <text x="155" y="84" fontFamily="var(--mono)" fontSize="9" fill="var(--accent)">B</text>
              <text x="90" y="108" fontFamily="var(--mono)" fontSize="9" fill="var(--accent)" textAnchor="middle">live · flowing</text>
            </svg>}
            foot={<><b>Live</b> marks the edge the current run came through; animated dash + ember filter-shadow.</>} />

          <Card name="RunPellet"
            desc="Tiny rounded chip inside an active StepNode, naming the live tasks currently at that step."
            canvas={<><RunPellet id="c794b783" /><RunPellet id="40628099" /></>}
            foot={<><b>Click</b> to focus that task in tasks-v2.</>} />

          <Card name="Minimap"
            desc="Faithful reduction of the main canvas. Nodes preserve kind palette; active step pulses; viewport drawn as a dashed accent box."
            canvas={<Minimap />}
            foot={<><b>Always-on</b> in bottom-right corner of design-v2 canvas.</>} />

          <Card name="ZoomWidget"
            desc="Vertical +/-/fit button stack pinned to bottom-left of pannable canvases."
            canvas={<ZoomWidget />}
            foot={<><b>Buttons:</b> zoom-in · zoom-out · fit-to-content.</>} />
        </div>
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  6 · TRACES
  // ════════════════════════════════════════════════════════════
  function Traces() {
    return (
      <Section num="10" name="traces" title="Traces."
        lede="The chronicle of one run. FlightStrip pins time horizontally; the event stream plays it back row by row.">
        <div className="grid full">
          <Card name="FlightStrip" em="three lanes"
            desc="Steps lane uses StepKind hues as bars. Tools and Turns lanes use pips. Viewport range marks the visible window; play-head marks the newest event."
            canvasStyle={{ minHeight: 130 }}
            canvas={<FlightStrip
              steps={[
                { kind: 'execute', left: '2%', width: '8%' }, { kind: 'eval', left: '11%', width: '6%' },
                { kind: 'route', left: '18%', width: '4%' }, { kind: 'execute', left: '23%', width: '14%' },
                { kind: 'wait', left: '38%', width: '56%', live: true },
              ]}
              tools={[{ left: '4%' }, { left: '7%' }, { left: '14%' }, { left: '24%' }, { left: '30%' }, { left: '33%', error: true }, { left: '36%' }]}
              turns={['3%', '6%', '11%', '16%', '23%', '28%']}
              viewport={{ left: '5%', width: '8%' }} play="94%"
              ticks={['+0s', '+18m', '+36m', '+54m', '+1h12m', '+1h30m', '+1h48m', '+2h06m', '+2h24m', '+2h42m']} />}
            foot={<><b>Lanes:</b> Steps (kind bars) · Tools (pips, errors red) · Turns (neutral pips). <b>Live segment</b> gets ember outline. <Rule>Rule — never label markers with text.</Rule></>} />

          <Card name="EventCard" em="five kinds"
            desc="The event stream is heterogeneous. Each kind has its own card shape so the eye lands on the right thing first."
            canvasClass="col start" canvasStyle={{ padding: 'var(--s-3)', gap: 4 }}
            canvas={<>
              <EventCard type="step" kind="execute" at="01:13:42.483" rel="+0s" to="accept_user_turn" />
              <EventCard type="agent" at="01:13:54.033" rel="+11.5s" speaker="Agent · Codex"
                prose="I'll ground this in the live tracker record and nearby Sacrum code paths first, then create only direct child tasks in dependency order." />
              <EventCard type="tool" at="01:14:01.110" rel="+18.6s" cmd="rg" flag="-n" em={'"chat runner activity|hydrate_session"'} dur="142ms" />
              <EventCard type="tool" error at="01:22:48.300" rel="+9m 06s" cmd="mix test" em="chat_session_runner_test.exs" dur="2.4s" />
              <EventCard type="error" at="01:22:48.150" rel="+9m 06s" title="tool · run_tests failed (exit 1)" sub="2 of 41 tests failed. Retrying with isolated runner." />
              <EventCard type="step" kind="wait" at="01:50:14.847" rel="+36m 32s" pre="tool fan-out" to="wait_for_children" />
              <EventCard type="wait" at="01:50:15.012" rel="+36m 32s" text="Waiting on 3 child tasks · 7h 36m" id="c794b783" />
            </>}
            foot={<><b>Card shapes by kind:</b> step (left-bordered pill) · agent (speaker + prose) · tool (code line) · wait (warn, animated bar) · error (red). <Rule>Rule — the visual treatment IS the label.</Rule></>} />
        </div>
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  11 · FILTERS & SEARCH
  // ════════════════════════════════════════════════════════════
  function Filters() {
    return (
      <Section num="11" name="filters" title="Filters &amp; search."
        lede="Faceted, count-aware, keyboard-friendly. The same idiom across every list. Everything here is live.">
        <div className="grid">
          <Card name="ScopeRow + ScopeChip"
            desc="Single-select filter chips with count badges. Active in accent (or err for error scopes). Separators group facets. Click to select."
            canvasClass="col start" canvasStyle={{ padding: 'var(--s-3)', alignItems: 'flex-start', gap: 10 }}
            canvas={<>
              <ScopeRow defaultValue="active" scopes={[
                { id: 'active', label: 'Active', n: 3 }, { id: 'waiting', label: 'Waiting', n: 14 },
                { id: 'blocked', label: 'Blocked', n: 2 }, { id: 'recent', label: 'Recent' },
                { sep: true }, { id: 'backlog', label: 'Backlog', n: 68 }, { id: 'done', label: 'Done', n: 19 },
              ]} />
              <ScopeRow defaultValue="errors" scopes={[
                { id: 'all', label: 'All', n: 52 }, { id: 'steps', label: 'Steps', n: 5 },
                { id: 'tools', label: 'Tools', n: 31 }, { id: 'turns', label: 'Turns', n: 14 },
                { id: 'waits', label: 'Waits', n: 1 }, { id: 'errors', label: 'Errors', n: 1, err: true },
              ]} />
            </>}
            foot={<><b>Used in:</b> tasks scope row · traces filter row. <b>Counts</b> always live.</>} />

          <Card name="SearchBar"
            desc="bg-1 fill, magnifier icon, kbd hint on the right. Focus = accent border + glow. Type into it."
            canvas={<SearchBar placeholder="Search tasks by title, id, or tag…" hint="/" />}
            foot={<><b>Hint glyph</b> shows which key focuses it. <b>Behavior:</b> filters live as you type.</>} />

          <Card name="LevelSelect"
            desc="Secondary filter dropdown. Mono, minimal — never the primary filter. Used to flatten a hierarchy."
            canvas={<LevelSelect />}
            foot={<><Rule>Rule — keep secondary filters as plain selects, not chip rows.</Rule></>} />
        </div>
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  12 · TABS & SWITCHES
  // ════════════════════════════════════════════════════════════
  function Switches() {
    return (
      <Section num="12" name="switches" title="Tabs &amp; switches."
        lede="View-switching, overlay-toggling, the tiny pill that says &ldquo;follow the head,&rdquo; and the buttons that act.">
        <div className="grid">
          <Card name="ViewTabs"
            desc="Segmented control for parallel views of the same data. Two-item is canonical (List ⇄ Board)."
            canvas={<ViewTabs defaultValue="board" tabs={[
              { id: 'list', label: 'List', icon: 'list' }, { id: 'board', label: 'Board', icon: 'board' },
            ]} />}
            foot={<><b>Sits in:</b> top toolbar. <b>Sync:</b> selection survives the switch.</>} />

          <Card name="OverlayToggle"
            desc="Segmented control that modifies how a surface paints (not what it shows). Live state carries a pulse dot."
            canvas={<OverlayToggle defaultValue="active" options={[
              { id: 'active', label: 'Active runs', pulse: true }, { id: 'recent', label: 'Recent' }, { id: 'off', label: 'Off' },
            ]} />}
            foot={<><b>Used in:</b> design-v2 graph header. <b>Off</b> hides live edges + active ember.</>} />

          <Card name="AutoScrollSwitch"
            desc="A tiny pill: when on, the surface follows the newest event. Knob turns ember when active. Click to toggle."
            canvas={<><AutoScrollSwitch defaultOn /><AutoScrollSwitch defaultOn={false} /></>}
            foot={<><b>Active by default</b> on live runs. Toggling off pins the viewport.</>} />

          <Card name="IconButton"
            desc="26–28px utility button for header actions. Outlined on hover, no fill by default."
            canvas={<>
              <IconButton icon="detach" title="Detach" /><IconButton icon="play" title="Run" />
              <IconButton icon="more" title="More" /><IconButton icon="close" title="Close" />
            </>}
            foot={<><b>Sizes:</b> 26px (compact) · 28px (header). <Rule>No filled variant — chips handle emphasis.</Rule></>} />

          <Card name="Button"
            desc="Three text-button variants: primary (accent fill), ghost (transparent), small. For destination actions."
            canvas={<><Button variant="primary">＋ New</Button><Button variant="ghost">＋ Add task</Button><Button size="sm">⊙ Inspect</Button></>}
            foot={<><b>Use sparingly</b> — most actions are IconButtons. Primary fills only the one destination action per surface.</>} />
        </div>
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  13 · MOTION
  // ════════════════════════════════════════════════════════════
  function Motion() {
    return (
      <Section num="13" name="motion" title="Motion."
        lede="Three keyframes do all the work. Pulse for &ldquo;this is alive.&rdquo; Spin for &ldquo;this is busy.&rdquo; Flow for &ldquo;this is moving.&rdquo;">
        <div className="grid">
          <Card name="pulse" em="1.6s ease-in-out infinite"
            desc="Slow opacity + glow oscillation. The visual language of &ldquo;running.&rdquo;"
            canvas={<><StepDot variant="running" /><StepDot variant="running" /><StepDot variant="running" /></>}
            foot={<><b>Applied to:</b> running run-chip rail · running step dot · active edge glow · active node ember · activity pulse.</>} />

          <Card name="spin" em="0.8s linear infinite"
            desc="A circle missing one quadrant rotating. Lives inside running chips."
            canvas={<><RunChip state="running" label="Running" /><RunChip state="running" label="2m" sm /></>}
            foot={<><b>Border-right</b> is transparent — the spinner inherits chip color. <Rule>Rule — never spin a non-running thing.</Rule></>} />

          <Card name="flow" em="1.4s edge · 2.4s wait"
            desc="Movement along an axis. Two forms: stroke-dashoffset along a live SVG edge, and background-position along a wait-bar."
            canvasClass="col"
            canvas={<><FlowEdge width={240} /><WaitBar /></>}
            foot={<><b>Live edges</b> use flow @ 1.4s. <b>Wait bars</b> use flow @ 2.4s — slower because waiting is a longer-felt state.</>} />
        </div>

        <div className="ember-callout"><em>One library.</em> Every component in this catalog is a real React component imported from <code style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--accent)' }}>lib/*.jsx</code> — driven by props, interactive where it counts, built on the exact token + class vocabulary the spec defines.</div>
      </Section>
    );
  }

  // ════════════════════════════════════════════════════════════
  //  8 · SHELL
  // ════════════════════════════════════════════════════════════
  function Shell() {
    const railItems = [
      { id: 'tasks', icon: 'list' }, { id: 'board', icon: 'board' },
      { id: 'design', icon: 'design' }, { id: 'traces', icon: 'traces' },
    ];
    return (
      <Section num="06" name="shell" title="Shell."
        lede="The frame around every page. Same topbar, same rail, same connection indicator, on every surface.">
        <div className="grid">
          <Card name="TopBar"
            desc="Brand mark with ember dot · breadcrumb (project › page) · live activity readout · ⌘K hint."
            canvasStyle={{ padding: 0, minHeight: 0 }}
            canvas={<TopBar project="sacrum" page="Tasks" running={3} total={100} />}
            foot={<><b>Height:</b> fixed. <b>Activity:</b> live count on accent + total in neutral. <Rule>Rule — never add metrics beyond running count + total.</Rule></>} />

          <Card name="SideRail"
            desc="44px vertical rail. Logo, divider, icon items, active state with accent stripe + glow, vertical &ldquo;connected&rdquo; label."
            canvasClass="tall" canvasStyle={{ padding: 'var(--s-3)', justifyContent: 'flex-start' }}
            canvas={<SideRail items={railItems} active="tasks" height={200} />}
            foot={<><b>Item states:</b> rest · hover · active. <Rule>Rule — never expand the rail. It stays at 44px.</Rule></>} />

          <Card name="AppFrame"
            desc="The shell composer: TopBar over a horizontal flex of SideRail + center column + optional right Inspector."
            canvasStyle={{ padding: 0, minHeight: 0 }}
            canvas={<AppFrame />}
            foot={<><b>Inspector states:</b> open (360px) · closed (slide-out). <Rule>Rule — always-on for Tasks, collapsible on Design / Traces.</Rule></>} />
        </div>
      </Section>
    );
  }

  // ── App ─────────────────────────────────────────────────────
  function App() {
    return (
      <>
        <Foundations />
        <Primitives />
        <Hierarchy />
        <Compound />
        <Layouts />
        <Shell />
        <Rows />
        <Detail />
        <Graph />
        <Traces />
        <Filters />
        <Switches />
        <Motion />
      </>
    );
  }

  ReactDOM.createRoot(document.getElementById('catalogBody')).render(<App />);
})();
