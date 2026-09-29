import type {
  LocalChatHarnessCatalog,
  LocalChatHarnessInfo,
  LocalChatProviderInfo,
} from "../bindings";

const BUILTIN_PROVIDERS = [
  { id: "anthropic", label: "Anthropic", harness: "claude" },
  { id: "openai", label: "OpenAI", harness: "codex" },
] as const;

/**
 * Complete a harness-only catalog fixture with the built-in provider choices
 * the backend derives from it (Anthropic -> claude, OpenAI -> codex), plus
 * any custom providers.
 */
export function withBuiltinProviders(
  catalog: {
    default_harness: LocalChatHarnessCatalog["default_harness"];
    // Fixtures often omit fields the component under test never reads.
    harnesses: ReadonlyArray<
      Pick<
        LocalChatHarnessInfo,
        "harness" | "available" | "unavailable_reason" | "default_model_id"
      > &
        Partial<LocalChatHarnessInfo>
    >;
  },
  customProviders: LocalChatProviderInfo[] = []
): LocalChatHarnessCatalog {
  const harnesses = [...catalog.harnesses] as LocalChatHarnessInfo[];
  const builtins = BUILTIN_PROVIDERS.flatMap(({ id, label, harness }) => {
    const info = harnesses.find((candidate) => candidate.harness === harness);
    return info
      ? [
          {
            id,
            label,
            harness,
            custom: false,
            available: info.available,
            unavailable_reason: info.unavailable_reason,
            models: null,
            default_model_id: info.default_model_id,
          } satisfies LocalChatProviderInfo,
        ]
      : [];
  });
  return {
    default_harness: catalog.default_harness,
    harnesses,
    default_provider:
      BUILTIN_PROVIDERS.find(({ harness }) => harness === catalog.default_harness)
        ?.id ?? "anthropic",
    providers: [...builtins, ...customProviders],
  };
}
