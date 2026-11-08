import {
  MIN_SPLIT_PANE_WIDTH as MIN,
  PANE_SEPARATOR_WIDTH,
} from "../../hooks/useChatPaneManagement";

export type PaneWidths = Readonly<Record<string, number>>;

/** Proportional allocation with a floor. Retain preferred proportions separately
 * so a temporarily narrow container does not erase the user's allocation. */
export function allocatePaneWidths(
  ids: readonly string[],
  containerWidth: number,
  preferred: PaneWidths = {}
): PaneWidths {
  const available = Number.isFinite(containerWidth)
    ? Math.max(0, containerWidth)
    : 0;
  const minimumWidth = ids.length * MIN;
  const separatorCount = Math.max(0, ids.length - 1);
  const separatorWidth = separatorCount * PANE_SEPARATOR_WIDTH;
  const availablePaneWidth = available - separatorWidth;

  let remaining = Math.max(minimumWidth, availablePaneWidth);
  let pending = [...ids];
  const result: Record<string, number> = {};

  const weightEntries = ids.map((id) => {
    const preferredWidth = preferred[id];
    const hasValidPreference =
      Number.isFinite(preferredWidth) && preferredWidth > 0;
    const weight = hasValidPreference ? preferredWidth : 1;

    return [id, weight];
  });
  const weights = Object.fromEntries(weightEntries);

  while (pending.length) {
    // Scale first to avoid overflowing the sum for invalid/extreme saved inputs.
    const pendingWeights = pending.map((id) => weights[id]);
    const max = Math.max(...pendingWeights);
    const total = pending.reduce((sum, id) => sum + weights[id] / max, 0);
    const small = pending.filter((id) => {
      const proposedWidth = (remaining * (weights[id] / max)) / total;

      return proposedWidth < MIN;
    });

    if (!small.length) {
      pending.forEach((id) => {
        const proportion = weights[id] / max / total;

        result[id] = remaining * proportion;
      });

      const sum = pending.reduce((sum, id) => sum + result[id], 0);
      const lastId = pending[pending.length - 1];

      result[lastId] += remaining - sum;
      break;
    }

    for (const id of small) {
      result[id] = MIN;
      remaining -= MIN;
    }

    pending = pending.filter((id) => !small.includes(id));
  }

  return result;
}

/** Move only one shared boundary; the adjacent pair's total is conserved. */
export function resizePanePair(
  widths: PaneWidths,
  left: string,
  right: string,
  delta: number
): PaneWidths {
  const leftWidth = widths[left];
  const rightWidth = widths[right];
  const pairWidth = leftWidth + rightWidth;

  if (
    !Number.isFinite(delta) ||
    !Number.isFinite(leftWidth) ||
    !Number.isFinite(rightWidth) ||
    !Number.isFinite(pairWidth) ||
    leftWidth < MIN ||
    rightWidth < MIN
  ) {
    return widths;
  }

  const maximumLeftWidth = pairWidth - MIN;
  const requestedLeftWidth = leftWidth + delta;
  const upperBoundedWidth = Math.min(maximumLeftWidth, requestedLeftWidth);
  const nextLeftWidth = Math.max(MIN, upperBoundedWidth);

  if (nextLeftWidth === leftWidth) return widths;

  return {
    ...widths,
    [left]: nextLeftWidth,
    [right]: pairWidth - nextLeftWidth,
  };
}
