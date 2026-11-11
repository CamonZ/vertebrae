/**
 * Accessible text for rendered parts (VL-09): name, universal state or
 * scenario, and change mark, matching the gallery's aria-labels.
 */
import type { UniversalState } from "./universalStates";

export type ChangeMark = "unchanged" | "added" | "changed" | "removed";

export interface PartIdentity {
  readonly name: string;
  readonly job: string;
  /** "Also known as" list, e.g. "process · handler · function". */
  readonly aka?: string;
}

/** State view: "<part>, <state>, <change>. <job>." */
export function stateLabel(
  part: PartIdentity,
  state: UniversalState,
  change: ChangeMark
): string {
  return `${part.name}, ${state}, ${change}. ${part.job}.`;
}

/** Scenario view: "<part>: <job>. Scenario: <name>. <change>. Also <aka>." */
export function scenarioLabel(
  part: PartIdentity,
  scenario: string,
  change: ChangeMark
): string {
  const aka = part.aka ? ` Also ${part.aka}.` : "";
  return `${part.name}: ${part.job}. Scenario: ${scenario}. ${change}.${aka}`;
}
