import type { LocalChatProviderInfo } from "../bindings";
import { withBuiltinProviders } from "./localChatCatalog";

const harnessCatalog = {
  default_harness: "claude",
  harnesses: [
    {
      harness: "claude",
      label: "Claude",
      available: true,
      unavailable_reason: null,
      default_model_id: "sonnet",
      reasoning_efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      speed_tiers: [
        { id: "default", label: "Standard" },
        { id: "fast", label: "Fast" },
      ],
      personality_options: [{ id: "Concise", label: "Concise" }],
      models: [
        { id: "sonnet", label: "Sonnet" },
        { id: "opus", label: "Opus" },
      ],
    },
    {
      harness: "codex",
      label: "Codex",
      available: true,
      unavailable_reason: null,
      default_model_id: "gpt",
      reasoning_efforts: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
      speed_tiers: [
        { id: "default", label: "Standard" },
        { id: "fast", label: "Fast" },
      ],
      personality_options: [
        { id: "none", label: "None" },
        { id: "friendly", label: "Friendly" },
      ],
      models: [
        {
          id: "gpt",
          label: "GPT",
          supported_speed_tier_ids: ["default", "fast"],
          supports_personality: true,
        },
      ],
    },
  ],
} satisfies Parameters<typeof withBuiltinProviders>[0];

const customProviders: LocalChatProviderInfo[] = [
  {
    id: "custom",
    label: "Custom",
    harness: "codex",
    custom: true,
    available: true,
    unavailable_reason: null,
    models: [
      {
        id: "dedicated",
        label: "Dedicated",
        supported_reasoning_effort_ids: ["high"],
        supported_speed_tier_ids: ["default", "fast"],
        supports_personality: true,
      },
      {
        id: "plain",
        label: "Plain",
        supported_reasoning_effort_ids: ["low"],
        supported_speed_tier_ids: ["default"],
        supports_personality: false,
      },
    ],
    default_model_id: "dedicated",
  },
];

export const inlineDiscussionCatalog = withBuiltinProviders(
  harnessCatalog,
  customProviders
);
