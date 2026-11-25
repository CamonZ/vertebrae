import {
  avatarHue,
  authorsOf,
  driftExplanation,
  initialOf,
  markerLabel,
  type ThreadMarker,
} from "./model";

const RAIL = "data-gh-marker-rail";
export const GITHUB_MARKER_ATTRIBUTE = "data-gh-marker";
const AVATAR = "data-gh-avatar";
const COUNT = "data-gh-count";
const DRIFT = "data-gh-drift";
/** Set on a file's diff host while it has markers: lines get the lane. */
const HAS_MARKERS = "data-gh-markers";

/** The markers' styles, for Pierre's shadow root (see the stylesheet). */
export { default as GITHUB_MARKERS_CSS } from "./markers.shadow.css?inline";

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
  const railOf = (row: HTMLElement) => {
    // The row's own rail, never one nested in its content.
    let rail = [...row.children].find((child): child is HTMLElement =>
      child.hasAttribute(RAIL)
    );
    if (!rail) {
      rail = root.ownerDocument.createElement("span");
      rail.setAttribute(RAIL, "");
      row.prepend(rail);
    }
    stale.delete(rail);
    return rail;
  };
  // Every drawn line of the file gets the lane, so it reads as one column.
  if (markers.length > 0)
    for (const row of root.querySelectorAll<HTMLElement>(
      "[data-code] [data-content] [data-line]"
    ))
      railOf(row);
  const buttons = new Set<HTMLButtonElement>();
  let focused = false;
  for (const marker of markers) {
    const row = rowFor(root, marker, diff);
    if (!row) continue;
    const rail = railOf(row);
    let button = rail.querySelector<HTMLButtonElement>(
      `[${GITHUB_MARKER_ATTRIBUTE}]`
    );
    if (!button) {
      button = root.ownerDocument.createElement("button");
      button.type = "button";
      button.setAttribute(GITHUB_MARKER_ATTRIBUTE, "");
      // Keep Pierre's line selection and the diff's cursor clicks out.
      button.addEventListener("pointerdown", (event) =>
        event.stopPropagation()
      );
      button.addEventListener("mousedown", (event) => event.stopPropagation());
      rail.append(button);
    }
    buttons.add(button);
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
  // A recycled row's marker for a line it no longer shows.
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    `[${GITHUB_MARKER_ATTRIBUTE}]`
  ))
    if (!buttons.has(button)) button.remove();
  return focused;
}
