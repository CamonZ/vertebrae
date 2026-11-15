import type { AtlasConnection, AtlasTrace } from "./useAtlasPresentation";

/** Rows shown per direction before the rest collapse into a count. */
const MAX_ROWS = 8;

const HEADINGS = {
  rail: { in: "From", out: "To" },
  step: { in: "Comes from", out: "Goes to" },
  workflow: { in: "Receives work from", out: "Hands work to" },
} as const;

/**
 * The hovered element's connections in words: every rail into and out of
 * it, by the name of its other end and its label. The colour bar on each
 * row matches the rail's colour on the canvas (incoming and outgoing).
 */
export function ConnectionsPanel({ trace }: { trace: AtlasTrace }) {
  const groups = (["in", "out"] as const)
    .map((direction) => ({
      direction,
      rows: trace.connections.filter((c) => c.direction === direction),
    }))
    .filter((g) => g.rows.length > 0);
  return (
    <aside
      className="uv-connections"
      aria-live="polite"
      data-testid="machine-connections"
    >
      <h3 className="uv-connections-title">{trace.title}</h3>
      {groups.length === 0 && (
        <p className="uv-connections-empty">No connections.</p>
      )}
      {groups.map(({ direction, rows }) => (
        <section key={direction} data-direction={direction}>
          <h4>{HEADINGS[trace.kind][direction]}</h4>
          <ul>
            {rows.slice(0, MAX_ROWS).map((c) => (
              <Row key={c.id} connection={c} />
            ))}
          </ul>
          {rows.length > MAX_ROWS && (
            <p className="uv-connections-more">
              and {rows.length - MAX_ROWS} more
            </p>
          )}
        </section>
      ))}
    </aside>
  );
}

function Row({ connection: c }: { connection: AtlasConnection }) {
  return (
    <li data-handoff={c.handoff || undefined}>
      <span className="uv-connections-end">
        {c.step ?? c.workflow}
        {c.step && c.handoff && (
          <span className="uv-connections-where"> in {c.workflow}</span>
        )}
      </span>
      {c.label && <span className="uv-connections-label">{c.label}</span>}
    </li>
  );
}
