import type { StepHarness } from "../../../bindings";

export const STEP_HARNESS_LABELS = {
  claude: "Claude",
  codex: "Codex",
  typesafe: "TypeSafe",
  acp: "ACP",
} satisfies Record<StepHarness, string>;
