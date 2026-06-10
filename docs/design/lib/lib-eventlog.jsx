/* ──────────────────────────────────────────────────────────────────
   Hearth component library · Event Log (unified)

   One log, two surfaces. The chat thread and the Traces stream are the
   SAME event log — the difference is grouping depth and the chrome
   bolted to either end (chat: composer; traces: flight strip).

   A clean reading hierarchy, three tiers:
     · STRUCTURE   step  → a quiet divider that segments the log
     · CONVERSATION user · agent · tool → the actual content
     · EXCEPTION   wait · error → salient, rare

   prompt-vs-agent, the honest difference between the two views:
     · user role="human"  → accent "You" row     (chat + trace)
     · user role="prompt" → quiet, collapsible    (trace only — the
       interpolated input fed into a step; the chat hides this)
     · agent              → ember speaker + prose + tools (both)

   timed mode (Traces) shows the time/rel/id gutter; bare mode (Chat)
   hides it. CSS injects itself so the component works wherever it loads.
   ────────────────────────────────────────────────────────────────── */
(function () {
  const { useState } = React;

  /* ── Self-injected styles (token-driven, theme-follows) ── */
  const CSS = `
  .evlog { display: flex; flex-direction: column; width: 100%; }
  .evlog--timed { gap: 1px; }
  .evlog--bare  { gap: var(--s-4); }

  .evrow { display: grid; gap: var(--s-3); align-items: flex-start; width: 100%; }
  .evlog--timed .evrow { grid-template-columns: 76px minmax(0, 1fr); padding: var(--s-1) 0; }
  .evlog--bare  .evrow { grid-template-columns: minmax(0, 1fr); }

  /* time gutter */
  .evwhen { font-family: var(--mono); font-size: var(--text-10); color: var(--fg-faint); text-align: right; padding-top: 2px; line-height: 1.35; }
  .evlog--bare .evwhen { display: none; }
  .evwhen .rel { display: block; font-size: var(--text-9); color: var(--fg-mute); margin-top: 1px; }
  .evwhen .c-id-chip { margin-top: var(--s-1); }

  .evbody { min-width: 0; }
  .evrow.sel .evbody, .evrow.sel .evtool.has-body { box-shadow: 0 0 0 1px var(--accent), 0 0 12px var(--accent-glow); }
  .evrow[data-clickable] { cursor: pointer; }

  /* ════ STRUCTURE · step divider ════ segments the log, never a box ════ */
  .evstep { display: grid; gap: var(--s-3); align-items: center; }
  .evlog--timed .evstep { grid-template-columns: 76px minmax(0, 1fr); padding: var(--s-4) 0 var(--s-1h); }
  .evlog--bare  .evstep { grid-template-columns: minmax(0, 1fr); padding: var(--s-2) 0 0; }
  .evstep:first-child { padding-top: var(--s-1); }
  .evlog--bare .evstep .evwhen { display: none; }
  .evstep-head { display: flex; align-items: center; gap: var(--s-2); padding-top: var(--s-3); border-top: 1px solid var(--line); cursor: pointer; }
  .evstep-tick { width: 8px; height: 8px; border-radius: 2px; background: var(--step-execute); flex-shrink: 0; }
  .evstep.kind-eval  .evstep-tick { background: var(--step-eval); }
  .evstep.kind-route .evstep-tick { background: var(--step-route); }
  .evstep.kind-wait  .evstep-tick { background: var(--step-wait); }
  .evstep.kind-human .evstep-tick { background: var(--step-human); }
  .evstep-arrow { color: var(--fg-ghost); font-family: var(--mono); font-size: var(--text-12); }
  .evstep-name { font-family: var(--mono); font-size: var(--text-12); color: var(--fg); letter-spacing: 0.01em; }
  .evstep-kind { font-family: var(--mono); font-size: var(--text-9); letter-spacing: 0.16em; text-transform: uppercase; color: var(--step-execute-fg); margin-left: var(--s-1); padding: 1px var(--s-1h); background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-xs); }
  .evstep.kind-eval  .evstep-kind { color: var(--step-eval-fg); }
  .evstep.kind-route .evstep-kind { color: var(--step-route-fg); }
  .evstep.kind-wait  .evstep-kind { color: var(--step-wait-fg); }
  .evstep.kind-human .evstep-kind { color: var(--step-human-fg); }
  .evstep-rt { margin-left: auto; font-family: var(--mono); font-size: var(--text-9); color: var(--fg-faint); letter-spacing: 0.04em; }
  .evstep.sel .evstep-name { color: var(--accent); }
  .evstep .evstep-head:hover .evstep-name { color: var(--fg); }

  /* ════ CONVERSATION ════ */

  /* user · human prompt — the accent head of a turn */
  .evrow--user .evbody {
    background: var(--accent-wash);
    border: 1px solid color-mix(in oklch, var(--accent) 26%, transparent);
    border-left: 3px solid var(--accent);
    border-radius: var(--r-sm);
    padding: var(--s-2) var(--s-3);
  }
  .ev-you { font-family: var(--mono); font-size: var(--text-9); letter-spacing: 0.16em; text-transform: uppercase; color: var(--accent); opacity: 0.85; white-space: nowrap; flex-shrink: 0; }
  .evrow--user .ev-text { font-family: var(--sans); font-size: var(--text-13); line-height: 1.5; color: var(--fg); white-space: pre-wrap; margin-top: 3px; }

  /* user · human prompt in BARE mode (chat) → right-aligned bubble.
     System/interpolated rows are excluded — machine input stays left. */
  .evlog--bare .evrow--user:not(.is-prompt):not(.is-system) { justify-items: end; }
  .evlog--bare .evrow--user:not(.is-prompt):not(.is-system) .evbody {
    max-width: 86%;
    border-left-width: 1px;
    border-bottom-right-radius: var(--r-xs);
    border-top-right-radius: var(--r-lg);
    border-top-left-radius: var(--r-lg);
    border-bottom-left-radius: var(--r-lg);
  }
  .evlog--bare .evrow--user:not(.is-prompt):not(.is-system) .ev-promptline { display: none; }
  .evlog--bare .evrow--user:not(.is-prompt):not(.is-system) .ev-text { margin-top: 0; }

  /* user · interpolated prompt — quiet, machine input, collapsible (trace only) */
  .evrow--user.is-prompt .evbody {
    background: color-mix(in oklch, var(--bg-2) 60%, transparent);
    border: 1px solid var(--line);
    border-left: 3px dashed var(--line-strong);
  }
  .evrow--user.is-prompt .ev-you { color: var(--fg-mute); opacity: 1; }
  .evrow--user.is-prompt .ev-text { color: var(--fg-mute); font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* system message — a first-class message type; quiet like an interpolated
     prompt but readable (wraps) and marked with a routing glyph */
  .evrow--user.is-system .ev-text { white-space: pre-wrap; overflow: visible; font-style: normal; }
  .evrow--user.is-system .evbody { border-left-style: solid; border-left-color: color-mix(in oklch, var(--step-route) 50%, var(--line-strong)); }
  .evrow--user.is-system .ev-you { color: var(--step-route-fg); }
  .ev-promptline { display: flex; align-items: center; gap: var(--s-2); flex-wrap: nowrap; margin-bottom: var(--s-1); }
  .ev-expand { font-family: var(--mono); font-size: var(--text-9); letter-spacing: 0.04em; color: var(--fg-faint); background: none; border: none; cursor: pointer; padding: 0; margin-left: auto; display: inline-flex; align-items: center; gap: 3px; }
  .ev-expand:hover { color: var(--accent); }
  .ev-expand .chev { transition: transform var(--t-fast) var(--ease); }
  .ev-expand.open .chev { transform: rotate(90deg); }
  .ev-prompt-body { margin-top: var(--s-2); padding: var(--s-2) var(--s-2h); background: var(--bg); border: 1px solid var(--line); border-radius: var(--r-xs); font-family: var(--mono); font-size: var(--text-11); line-height: 1.6; color: var(--fg-mute); white-space: pre-wrap; max-height: 220px; overflow-y: auto; }
  .ev-prompt-body::-webkit-scrollbar { width: 4px; }
  .ev-prompt-body::-webkit-scrollbar-thumb { background: var(--bg-4); border-radius: var(--r-xs); }

  /* agent — speaker · tools · prose */
  .ev-speaker { font-family: var(--mono); font-size: var(--text-10); letter-spacing: 0.14em; text-transform: uppercase; color: var(--fg-mute); display: flex; align-items: center; gap: var(--s-1h); margin-bottom: var(--s-1h); }
  .ev-speaker .ev-ember { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 6px var(--accent-glow); flex-shrink: 0; }
  .ev-speaker .model { color: var(--fg-faint); font-size: var(--text-9); padding: 1px var(--s-1h); border: 1px solid var(--line); border-radius: var(--r-xs); letter-spacing: 0.04em; text-transform: none; }
  .ev-tools { display: flex; flex-direction: column; gap: var(--s-1h); margin-bottom: var(--s-2); }
  .ev-tools:empty { display: none; }
  .evprose { font-family: var(--sans); font-size: var(--text-13); line-height: 1.6; color: var(--fg-soft); border-left: 2px solid var(--line-strong); padding-left: var(--s-3); }
  .evprose p { margin: 0; }
  .evprose p + p { margin-top: var(--s-2); }
  .evprose strong { color: var(--fg); font-weight: 600; }
  .evprose code { font-family: var(--mono); font-size: var(--text-12); color: var(--accent); background: var(--accent-wash); padding: 1px var(--s-1); border-radius: var(--r-xs); }
  .ev-cursor { display: inline-block; width: 7px; height: 14px; background: var(--accent); margin-left: 2px; vertical-align: -2px; box-shadow: 0 0 6px var(--accent-glow); animation: ev-blink 1s step-end infinite; }
  @keyframes ev-blink { 50% { opacity: 0; } }

  /* tool — bare shell line by default; bordered card only when it has output */
  .evtool { border-radius: var(--r-sm); width: 100%; }
  .evtool.has-body { border: 1px solid var(--line); background: var(--bg-2); overflow: hidden; }
  .evtool-hd { display: flex; align-items: center; gap: var(--s-1h); padding: var(--s-1) var(--s-1h); font-family: var(--mono); font-size: var(--text-11); color: var(--fg-soft); min-width: 0; }
  .evtool.has-body .evtool-hd { padding: var(--s-1h) var(--s-2); cursor: pointer; }
  .evtool.has-body .evtool-hd:hover { background: var(--bg-3); }
  .evtool-dot  { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex-shrink: 0; }
  .evtool-spin { width: 9px; height: 9px; border: 1.5px solid var(--accent); border-top-color: transparent; border-radius: 50%; animation: ev-spin 0.7s linear infinite; flex-shrink: 0; }
  @keyframes ev-spin { to { transform: rotate(360deg); } }
  .evtool-prompt { color: var(--fg-faint); flex-shrink: 0; }
  .evtool-name { color: var(--fg); font-weight: 500; flex-shrink: 0; }
  .evtool-args { color: var(--fg-mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .evtool-args em { font-style: normal; color: var(--accent); }
  .evtool-sum { color: var(--fg-faint); margin-left: var(--s-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .evtool-dur { margin-left: auto; color: var(--fg-faint); font-size: var(--text-9); flex-shrink: 0; padding-left: var(--s-2); }
  .evtool-chev { color: var(--fg-faint); font-size: var(--text-9); flex-shrink: 0; transition: transform var(--t-fast) var(--ease); margin-left: var(--s-1); }
  .evtool.collapsed .evtool-chev { transform: rotate(-90deg); }
  .evtool-bd { padding: var(--s-2) var(--s-2h); background: var(--bg); border-top: 1px solid var(--line); font-family: var(--mono); font-size: var(--text-11); line-height: 1.55; color: var(--fg-mute); white-space: pre-wrap; max-height: 168px; overflow-y: auto; }
  .evtool-bd::-webkit-scrollbar { width: 4px; }
  .evtool-bd::-webkit-scrollbar-thumb { background: var(--bg-4); border-radius: var(--r-xs); }
  .evtool.collapsed .evtool-bd { display: none; }
  .evtool.pending.has-body { border-color: color-mix(in oklch, var(--accent) 32%, transparent); }
  .evtool.pending .evtool-name { color: var(--accent); }
  .evtool.err.has-body { border-color: color-mix(in oklch, var(--err) 36%, transparent); }
  .evtool.err .evtool-dot { background: var(--err); }
  .evtool.err .evtool-name { color: var(--err); }

  /* ════ EXCEPTION ════ */
  .evrow--wait .evbody {
    padding: var(--s-2) var(--s-3);
    background: color-mix(in oklch, var(--step-wait-wash) 25%, var(--bg-2));
    border: 1px solid color-mix(in oklch, var(--step-wait) 30%, transparent);
    border-left: 3px solid var(--step-wait); border-radius: var(--r-sm);
    color: var(--step-wait-fg); font-family: var(--sans); font-size: var(--text-12);
    display: flex; align-items: center; gap: var(--s-2h);
  }
  .evrow--wait .flow { flex: 1; height: 3px; background: linear-gradient(to right, var(--step-wait) 40%, transparent); background-size: 200% 100%; animation: ev-flow 2.4s ease-in-out infinite; border-radius: var(--r-xs); }
  .evrow--wait .wid { color: var(--accent); font-family: var(--mono); font-size: var(--text-10); }
  @keyframes ev-flow { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }

  .evrow--error .evbody {
    padding: var(--s-2) var(--s-3);
    background: color-mix(in oklch, var(--err-wash) 30%, var(--bg-2));
    border: 1px solid color-mix(in oklch, var(--err) 30%, transparent);
    border-left: 3px solid var(--err); border-radius: var(--r-sm);
    color: var(--err); font-family: var(--sans); font-size: var(--text-12);
    display: flex; flex-direction: column; align-items: flex-start; gap: var(--s-1);
  }
  .evrow--error .sub { font-family: var(--mono); font-size: var(--text-11); color: var(--fg-mute); }
  `;

  function injectCSS() {
    if (typeof document === 'undefined' || document.getElementById('hearth-eventlog-styles')) return;
    const s = document.createElement('style');
    s.id = 'hearth-eventlog-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  injectCSS();

  /* ── minimal inline markdown: **bold** · `code` · <code>code</code> ── */
  function renderMd(text) {
    const out = []; let key = 0, last = 0, m;
    const re = /\*\*([^*]+)\*\*|`([^`]+)`|<code>([^<]+)<\/code>/g;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1] != null) out.push(<strong key={'b' + key++}>{m[1]}</strong>);
      else out.push(<code key={'c' + key++}>{m[2] != null ? m[2] : m[3]}</code>);
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function LogProse({ prose, streaming }) {
    if (prose == null && !streaming) return null;
    const inner = typeof prose === 'string' ? renderMd(prose) : prose;
    return <div className="evprose">{inner}{streaming ? <span className="ev-cursor" /> : null}</div>;
  }

  /* ── ToolRow — the merged tool (fn card · shell line) ──
     { name|cmd, args|flag+em, summary, body, dur, status, error, kind,
       collapsed, onToggle } */
  function ToolRow(props) {
    const status = props.error ? 'err'
      : (props.status === 'pending' ? 'pending' : props.status === 'err' ? 'err' : 'ok');
    const isShell = props.kind === 'shell' || (props.cmd != null && props.name == null);
    const name = props.name != null ? props.name : props.cmd;
    let args = props.args;
    if (args == null && (props.flag != null || props.em != null)) {
      args = <>{props.flag ? <span className="flag">{props.flag} </span> : null}{props.em ? <em>{props.em}</em> : null}</>;
    }
    const pending = status === 'pending';
    const hasBody = !pending && props.body != null && props.body !== '';
    const collapsed = !!props.collapsed;
    const cls = 'evtool'
      + (status === 'err' ? ' err' : pending ? ' pending' : '')
      + (hasBody ? ' has-body' : '')
      + (hasBody && collapsed ? ' collapsed' : '');
    return (
      <div className={cls}>
        <div className="evtool-hd" onClick={hasBody ? props.onToggle : undefined}>
          {pending ? <span className="evtool-spin" /> : <span className="evtool-dot" />}
          {isShell ? <span className="evtool-prompt">$</span> : null}
          <span className="evtool-name">{name}</span>
          {args ? <span className="evtool-args">{args}</span> : null}
          {props.summary ? <span className="evtool-sum">{pending ? 'running…' : props.summary}</span> : null}
          {props.dur ? <span className="evtool-dur">{props.dur}</span> : null}
          {hasBody ? <span className="evtool-chev">▾</span> : null}
        </div>
        {hasBody ? <div className="evtool-bd">{props.body}</div> : null}
      </div>
    );
  }

  /* ── time gutter ── */
  function EventWhen({ at, rel, id }) {
    const IdChip = window.IdChip || (() => null);
    if (at == null && rel == null && id == null) return <div className="evwhen" />;
    return (
      <div className="evwhen">
        {at}{rel ? <span className="rel">{rel}</span> : null}
        {id ? <IdChip id={id} /> : null}
      </div>
    );
  }

  /* ── StepDivider — STRUCTURE. Quiet rule that opens a step group. ──
     { at, rel, to, kind, runtime, selected, onClick } */
  function StepDivider({ at, rel, to, kind = 'execute', runtime, selected, onClick }) {
    return (
      <div className={'evstep kind-' + kind + (selected ? ' sel' : '')}>
        <EventWhen at={at} rel={rel} />
        <div className="evstep-head" onClick={onClick}>
          <span className="evstep-tick" />
          <span className="evstep-arrow">→</span>
          <span className="evstep-name">{to}</span>
          <span className="evstep-kind">{kind}</span>
          {runtime ? <span className="evstep-rt">{runtime}</span> : null}
        </div>
      </div>
    );
  }

  /* ── UserRow body — human prompt or interpolated step prompt ── */
  function UserBody({ role = 'human', label, text, body }) {
    const [open, setOpen] = useState(false);
    const isPrompt = role === 'prompt';
    return (
      <div className="evbody">
        <div className="ev-promptline">
          <span className="ev-you">{label || (isPrompt ? 'Prompt · interpolated' : 'You')}</span>
          {body ? (
            <button className={'ev-expand' + (open ? ' open' : '')} onClick={() => setOpen(!open)}>
              <span className="chev">▸</span>{open ? 'hide input' : 'show input'}
            </button>
          ) : null}
        </div>
        {text ? <div className="ev-text">{text}</div> : null}
        {body && open ? <div className="ev-prompt-body">{body}</div> : null}
      </div>
    );
  }

  /* ── AgentRow body — speaker · tools · prose ── */
  function AgentBody({ speaker, model, prose, tools = [], streaming }) {
    return (
      <div className="evbody">
        <div className="ev-speaker">
          {streaming ? <span className="evtool-spin" /> : <span className="ev-ember" />}
          {speaker || 'sacrum'}
          {model ? <span className="model">{model}</span> : null}
        </div>
        {tools.length ? <div className="ev-tools">{tools.map((t, i) => <ToolRow key={i} {...t} />)}</div> : null}
        <LogProse prose={prose} streaming={streaming} />
      </div>
    );
  }

  /* ── EventRow — one line in the log, dispatched by `type` ──
     user · agent · tool · step · wait · error */
  function EventRow(props) {
    const type = props.type || 'step';
    if (type === 'step') return <StepDivider {...props} />;

    const sel = props.selected ? ' sel' : '';
    // system renders with the user/prompt visual vocabulary (quiet, collapsible)
    const renderType = type === 'system' ? 'user' : type;
    const promptMod = (type === 'user' && props.role === 'prompt') ? ' is-prompt'
      : type === 'system' ? ' is-prompt is-system' : '';
    const clickable = props.onClick ? { 'data-clickable': '' } : {};

    let body;
    if (type === 'system') {
      body = <UserBody role="prompt" label={props.label || 'System'} text={props.text} body={props.body} />;
    } else if (type === 'user') {
      body = <UserBody role={props.role} label={props.label} text={props.text} body={props.body} />;
    } else if (type === 'agent') {
      body = <AgentBody speaker={props.speaker} model={props.model} prose={props.prose} tools={props.tools} streaming={props.streaming} />;
    } else if (type === 'tool') {
      body = <div className="evbody"><ToolRow {...props} /></div>;
    } else if (type === 'wait') {
      body = (
        <div className="evbody">
          <span>{props.text}</span>
          <span className="flow" />
          {props.wid ? <span className="wid">{props.wid}</span> : null}
        </div>
      );
    } else if (type === 'error') {
      body = (
        <div className="evbody">
          <b>{props.title}</b>
          {props.sub ? <span className="sub">{props.sub}</span> : null}
        </div>
      );
    }

    return (
      <div className={'evrow evrow--' + renderType + promptMod + sel} onClick={props.onClick} {...clickable}>
        <EventWhen at={props.at} rel={props.rel} id={props.id} />
        {body}
      </div>
    );
  }

  /* ── EventLog — wrapper that sets grouping/gutter mode ── */
  function EventLog({ mode = 'timed', className = '', children, ...rest }) {
    return <div className={'evlog evlog--' + mode + (className ? ' ' + className : '')} {...rest}>{children}</div>;
  }

  Object.assign(window, { EventLog, EventRow, ToolRow, StepDivider, LogProse, renderEventMd: renderMd });
})();
