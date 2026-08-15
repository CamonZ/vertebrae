import type { TaskLevel } from "../../bindings";

export const VTB_ENTITY_TYPES = [
  "epic",
  "ticket",
  "task",
  "step",
  "workflow",
  "project",
] as const;

export type VtbEntityType = (typeof VTB_ENTITY_TYPES)[number];

export interface VtbEntityTarget {
  type: VtbEntityType;
  id: string;
  href: string;
  route: string;
  level: TaskLevel | null;
}

function isVtbEntityType(value: string): value is VtbEntityType {
  return (VTB_ENTITY_TYPES as readonly string[]).includes(value);
}

function decodeUriSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function routeFor(type: VtbEntityType, id: string): string {
  const encoded = encodeURIComponent(id);
  switch (type) {
    case "epic":
    case "ticket":
    case "task":
      return `/tasks?taskId=${encoded}`;
    case "step":
      return `/design?stepId=${encoded}`;
    case "workflow":
      return `/design?workflowId=${encoded}`;
    case "project":
      return `/setup?project=${encoded}`;
  }
}

function levelFor(type: VtbEntityType): TaskLevel | null {
  switch (type) {
    case "epic":
    case "ticket":
    case "task":
      return type;
    case "step":
    case "workflow":
    case "project":
      return null;
  }
}

export function parseVtbEntityHref(
  href: string | null | undefined
): VtbEntityTarget | null {
  if (!href) return null;
  const scheme = "vtb://";
  if (!href.toLowerCase().startsWith(scheme)) return null;

  const withoutScheme = href.slice(scheme.length);
  const pathOnly = withoutScheme.split(/[?#]/, 1)[0] ?? "";
  const segments = pathOnly.split("/");
  if (segments.length !== 2) return null;

  const type = segments[0].trim().toLowerCase();
  const rawId = segments[1];
  if (!isVtbEntityType(type) || rawId.trim() === "") return null;

  const decodedId = decodeUriSegment(rawId);
  const id = decodedId?.trim() ?? "";
  if (!id) return null;

  return {
    type,
    id,
    href,
    route: routeFor(type, id),
    level: levelFor(type),
  };
}
