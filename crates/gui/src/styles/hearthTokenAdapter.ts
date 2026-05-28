export const V2_TOKEN_GROUPS = [
  {
    label: "Surface and text",
    tokens: [
      "--bg",
      "--bg-1",
      "--bg-2",
      "--bg-3",
      "--bg-4",
      "--fg",
      "--fg-soft",
      "--fg-mute",
      "--fg-faint",
      "--fg-ghost",
      "--line",
      "--line-strong",
    ],
  },
  {
    label: "Accent and status",
    tokens: [
      "--accent",
      "--accent-glow",
      "--accent-wash",
      "--ok",
      "--ok-wash",
      "--warn",
      "--warn-wash",
      "--err",
      "--err-wash",
    ],
  },
  {
    label: "Step kinds",
    tokens: [
      "--step-execute",
      "--step-execute-fg",
      "--step-eval",
      "--step-eval-fg",
      "--step-route",
      "--step-route-fg",
      "--step-human",
      "--step-human-fg",
      "--step-wait",
      "--step-wait-fg",
      "--step-wait-wash",
    ],
  },
  {
    label: "Type, space, radius, motion",
    tokens: [
      "--serif",
      "--sans",
      "--mono",
      "--s-2",
      "--s-3",
      "--s-4",
      "--r-xs",
      "--r-sm",
      "--r-md",
      "--t-fast",
      "--ease",
    ],
  },
] as const;

export const V2_TOKENS = V2_TOKEN_GROUPS.flatMap(
  (group) => group.tokens
).sort();
