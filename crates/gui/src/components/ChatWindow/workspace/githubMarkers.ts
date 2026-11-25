import {
  avatarHue,
  authorsOf,
  driftExplanation,
  initialOf,
  markerLabel,
  type ThreadMarker,
} from "./githubReview";

const RAIL = "data-gh-marker-rail";
export const GITHUB_MARKER_ATTRIBUTE = "data-gh-marker";
const AVATAR = "data-gh-avatar";
const COUNT = "data-gh-count";
const DRIFT = "data-gh-drift";
/** Set on a file's diff host while it has markers: lines reserve the slot. */
const HAS_MARKERS = "data-gh-markers";

/**
 * GitHub thread markers in Pierre's rows. Each sits in a fixed slot at the
 * visible right edge of its code line (sticky while the code scrolls
 * sideways), so markers align across rows and code never runs under them.
 * The marker carries no text nodes (initials and counts are generated
 * content), so line text, copying and the cursor's text ranges are
 * unaffected. GitHub markers stay neutral: rose marks private actions.
 */
export const GITHUB_MARKERS_CSS = `
:host([${HAS_MARKERS}]) [data-content] [data-line] {
  padding-inline-end: 64px;
}
[${RAIL}] {
  display: block;
  position: sticky;
  left: var(--diffs-column-number-width, 0);
  inline-size: calc(var(--diffs-column-content-width, 100%) - 2ch);
  block-size: 0;
  pointer-events: none;
  user-select: none;
  z-index: 2;
}
[${GITHUB_MARKER_ATTRIBUTE}] {
  appearance: none;
  pointer-events: auto;
  position: absolute;
  inset-inline-end: 4px;
  inset-block-start: calc((1lh - 20px) / 2);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-inline-size: 24px;
  block-size: 20px;
  padding: 0 5px 0 2px;
  border: 1px solid var(--color-line-strong, var(--diffs-fg));
  border-radius: var(--radius-full, 999px);
  background: var(--color-bg-2, var(--diffs-bg));
  color: var(--color-fg-soft, var(--diffs-fg));
  font: 600 var(--text-meta, 11px)/1 var(--font-sans, sans-serif);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
/* A 24px hit target around the 20px pill (WCAG 2.2 target size). */
[${GITHUB_MARKER_ATTRIBUTE}]::after {
  content: "";
  position: absolute;
  inset: -2px;
}
[${GITHUB_MARKER_ATTRIBUTE}]:hover,
[${GITHUB_MARKER_ATTRIBUTE}][aria-expanded="true"] {
  border-color: var(--color-fg-mute, currentColor);
  color: var(--color-fg, var(--diffs-fg));
}
[${GITHUB_MARKER_ATTRIBUTE}][data-resolved] {
  border-style: dashed;
  color: var(--color-fg-mute, var(--diffs-fg));
}
[${GITHUB_MARKER_ATTRIBUTE}]:focus-visible {
  outline: 2px solid var(--color-fg-mute, currentColor);
  outline-offset: 1px;
}
[${AVATAR}] {
  display: inline-grid;
  place-items: center;
  inline-size: 16px;
  block-size: 16px;
  border-radius: 50%;
  background: oklch(from var(--color-avatar) l c var(--gh-hue));
  color: var(--color-fg, var(--diffs-fg));
  font-size: 10px;
}
[${AVATAR}]::before {
  content: attr(data-initial);
}
[${AVATAR}] + [${AVATAR}] {
  margin-inline-start: -6px;
  box-shadow: 0 0 0 1.5px var(--color-bg-2, var(--diffs-bg));
}
[${COUNT}]::before {
  content: attr(data-count);
  padding-inline-start: 2px;
}
[${COUNT}][data-resolved-count]::after {
  content: "✓" attr(data-resolved-count);
  padding-inline-start: 3px;
  color: var(--color-ok-fg, currentColor);
}
[${DRIFT}] {
  color: var(--color-info, currentColor);
  padding-inline-start: 1px;
}
[${DRIFT}="moved"]::before {
  content: "↕";
}
[${DRIFT}="edited"]::before {
  content: "✎";
}
[${DRIFT}="unverified"]::before {
  content: "?";
}
`;

function rowFor(
  root: ShadowRoot,
  marker: ThreadMarker,
  diff: MarkerDiff
): HTMLElement | null {
  const index = diff.getLineIndex(marker.line, marker.side)?.join(",");
  if (index === undefined) return null;
  return root.querySelector<HTMLElement>(
    `[data-code][data-${marker.side}] [data-content] [data-line-index="${index}"], ` +
      `[data-code][data-unified] [data-content] [data-line-index="${index}"]`
  );
}

interface MarkerDiff {
  getLineIndex(
    line: number,
    side: ThreadMarker["side"]
  ): readonly number[] | undefined;
}

function fill(button: HTMLButtonElement, marker: ThreadMarker, open: boolean) {
  const label = markerLabel(marker);
  const resolved = marker.threads.filter(
    ({ thread }) => thread.resolved
  ).length;
  const unresolved = marker.threads.length - resolved;
  const explanation = marker.threads
    .map(driftExplanation)
    .find((text) => text !== null);
  const names = authorsOf(marker.threads);
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-expanded", String(open));
  button.title = `${names.join(", ")} · line ${marker.line}${explanation ? ` · ${explanation}` : ""} (o or ↵ to open)`;
  button.toggleAttribute("data-resolved", unresolved === 0);
  const parts: HTMLElement[] = names.slice(0, 2).map((login) => {
    const avatar = button.ownerDocument.createElement("span");
    avatar.setAttribute(AVATAR, "");
    avatar.setAttribute("data-initial", initialOf(login));
    avatar.style.setProperty("--gh-hue", String(avatarHue(login)));
    return avatar;
  });
  if (marker.threads.length > 1 || unresolved === 0) {
    const count = button.ownerDocument.createElement("span");
    count.setAttribute(COUNT, "");
    if (unresolved === 0) {
      count.setAttribute("data-count", "");
      count.setAttribute(
        "data-resolved-count",
        marker.threads.length > 1 ? String(resolved) : ""
      );
    } else {
      count.setAttribute("data-count", String(unresolved));
      if (resolved > 0)
        count.setAttribute("data-resolved-count", String(resolved));
    }
    parts.push(count);
  }
  const drift = marker.threads.find(({ drift }) => drift.kind !== "current")
    ?.drift.kind;
  if (drift) {
    const glyph = button.ownerDocument.createElement("span");
    glyph.setAttribute(DRIFT, drift);
    parts.push(glyph);
  }
  button.replaceChildren(...parts);
}

/**
 * Reconcile the markers of one rendered diff item with its mounted rows.
 * Pierre virtualizes and recycles rows, so call this after every render.
 * Returns true when `focusKey`'s marker took focus.
 */
export function syncGithubMarkers(
  root: ShadowRoot,
  host: HTMLElement,
  diff: MarkerDiff,
  markers: readonly ThreadMarker[],
  isOpen: (key: string) => boolean,
  toggle: (marker: ThreadMarker) => void,
  focusKey?: string
): boolean {
  const stale = new Set(root.querySelectorAll<HTMLElement>(`[${RAIL}]`));
  host.toggleAttribute(HAS_MARKERS, markers.length > 0);
  let focused = false;
  for (const marker of markers) {
    const row = rowFor(root, marker, diff);
    if (!row) continue;
    let rail = row.querySelector<HTMLElement>(`:scope > [${RAIL}]`);
    let button = rail?.querySelector<HTMLButtonElement>(
      `[${GITHUB_MARKER_ATTRIBUTE}]`
    );
    if (!rail || !button) {
      rail = root.ownerDocument.createElement("span");
      rail.setAttribute(RAIL, "");
      button = root.ownerDocument.createElement("button");
      button.type = "button";
      button.setAttribute(GITHUB_MARKER_ATTRIBUTE, "");
      // Keep Pierre's line selection and the diff's cursor clicks out.
      button.addEventListener("pointerdown", (event) =>
        event.stopPropagation()
      );
      button.addEventListener("mousedown", (event) => event.stopPropagation());
      rail.append(button);
      row.prepend(rail);
    }
    stale.delete(rail);
    const signature = JSON.stringify([
      marker.key,
      isOpen(marker.key),
      marker.threads.map(({ thread, drift }) => [
        thread.id,
        thread.resolved,
        drift.kind,
      ]),
    ]);
    if (button.dataset.signature !== signature) {
      button.dataset.signature = signature;
      button.dataset.markerKey = marker.key;
      fill(button, marker, isOpen(marker.key));
    }
    const target = marker;
    button.onclick = (event) => {
      event.stopPropagation();
      toggle(target);
    };
    if (marker.key === focusKey) {
      button.focus({ preventScroll: true });
      focused = root.activeElement === button;
    }
  }
  for (const rail of stale) rail.remove();
  return focused;
}
