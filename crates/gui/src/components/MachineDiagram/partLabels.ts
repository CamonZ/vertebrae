/** Explicit label policy; absence preserves the legacy, scale-dependent header. */
import type { ChangeMark, PartIdentity } from "./accessibility";
import type { BBox } from "./ChangeMark";
import type { Timeline } from "./timeline";
import { textBox, textWidth } from "./flow/measure";

export const TITLE_PLACEMENTS = ["shown", "hover", "hidden"] as const;
export const SUBTITLE_PLACEMENTS = [
  "beside",
  "below",
  "hover",
  "hidden",
] as const;
export interface PartLabels {
  readonly title?: (typeof TITLE_PLACEMENTS)[number];
  readonly subtitle?: (typeof SUBTITLE_PLACEMENTS)[number];
}

/** Diagram-local geometry, shared by painting and ELK extents. Hover never reserves space. */
export function placedLabels(p: {
  identity: PartIdentity;
  bb: BBox;
  scale: number;
  timeline: Timeline;
  labels: PartLabels;
  change?: ChangeMark;
  changeNote?: string;
}) {
  const title = p.labels.title ?? "shown";
  const subtitle = p.labels.subtitle ?? "beside";
  const size = 22;
  const gap = 28;
  const top =
    Math.min(
      p.bb[1],
      ...p.timeline.gates.map((g) => g.y - 34),
      // A full-scale change note remains in its original slot at y=64.
      ...(p.change === "changed" && p.changeNote && p.scale >= 1 ? [50] : [])
    ) *
      p.scale -
    36;
  const x = (p.bb[0] + p.bb[2] / 2) * p.scale;
  const shownTitle = title === "shown";
  const shownSub = subtitle === "beside" || subtitle === "below";
  const stacked = subtitle === "below" && shownTitle;
  const titleY = top - (stacked ? gap : 0);
  const beside = subtitle === "beside" && shownTitle;
  const subText = beside ? `  ·  ${p.identity.job}` : p.identity.job;
  const titleW = shownTitle ? textWidth(p.identity.name, size) : 0;
  const subW = shownSub ? textWidth(subText, size) : 0;
  const start = x - (titleW + (beside ? subW : 0)) / 2;
  return [
    ...(title !== "hidden"
      ? [
          {
            key: "title",
            text: p.identity.name,
            hover: title === "hover",
            x: shownTitle ? start : x - textWidth(p.identity.name, size) / 2,
            y:
              title === "hover"
                ? top - (subtitle !== "hidden" ? gap : 0)
                : titleY,
            size,
            weight: 600 as const,
            role: "ink" as const,
          },
        ]
      : []),
    ...(subtitle !== "hidden"
      ? [
          {
            key: "subtitle",
            text: subText,
            hover: subtitle === "hover",
            x: beside ? start + titleW : x - textWidth(subText, size) / 2,
            y: subtitle === "hover" ? top - (shownTitle ? gap : 0) : top,
            size,
            weight: 400 as const,
            role: "dim" as const,
          },
        ]
      : []),
  ].map((l) => ({ ...l, box: textBox(l.x, l.y, l.text, l.size) }));
}
