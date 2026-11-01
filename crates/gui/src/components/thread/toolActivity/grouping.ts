import type { Message, ToolMessage } from "../types";
import type { ActivityAnalysis } from "./types";
export function groupToolMessages(
  messages: Message[]
): (Message | ToolMessage[])[] {
  const groups: (Message | ToolMessage[])[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (m.type === "tool") {
      if (Array.isArray(last)) last.push(m);
      else groups.push([m]);
    } else groups.push(m);
  }
  return groups;
}
export function activitySummary(rows: ActivityAnalysis[]): {
  labels: string[];
  overflow: number;
} {
  const labels = new Set<string>();
  let unresolved = false;
  for (const row of rows) {
    for (const operation of row.operations) {
      operation.activities.forEach((label) => labels.add(label));
      if (operation.unresolved && !operation.activities.length)
        unresolved = true;
    }
  }
  if (unresolved) labels.add("other operations");
  const ordered = [...labels];
  return {
    labels: ordered.slice(0, 4),
    overflow: Math.max(0, ordered.length - 4),
  };
}
export function activityLabel(rows: ActivityAnalysis[]): string {
  const { labels, overflow } = activitySummary(rows);
  return labels.join(", ") + (overflow ? ` +${overflow} more` : "");
}
