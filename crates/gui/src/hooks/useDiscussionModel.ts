import { useEffect, useMemo, useState } from "react";
import { commands, type LocalChatHarnessCatalog } from "../bindings";
import { useUIStore } from "../stores/uiStore";
import { useProviderSettingsStore } from "../stores/providerSettingsStore";
import {
  resolveDiscussionModel,
  type DiscussionModelChoice,
  type MainDiscussionSelection,
} from "../utils/inlineDiscussionModel";

export function useDiscussionModel(
  main: MainDiscussionSelection,
  enabled: boolean
): DiscussionModelChoice {
  const preference = useUIStore((state) => state.inlineDiscussionPreference);
  const revision = useProviderSettingsStore((state) => state.revision);

  const [loaded, setLoaded] = useState<{
    revision: number;
    catalog?: LocalChatHarnessCatalog;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!enabled || loaded?.revision === revision) return;

    let retired = false;

    void commands
      .getSupportedLocalChatHarnesses()
      .then((result) => {
        if (retired) return;

        const nextCatalog =
          result.status === "ok"
            ? { revision, catalog: result.data }
            : {
                revision,
                error:
                  "Could not load providers. Check Settings → Providers & Models, then reopen this conversation.",
              };

        setLoaded(nextCatalog);
      })
      .catch(() => {
        if (retired) return;

        const failedCatalog = {
          revision,
          error:
            "Could not load providers. Check Settings → Providers & Models, then reopen this conversation.",
        };

        setLoaded(failedCatalog);
      });

    return () => {
      retired = true;
    };
  }, [revision, enabled, loaded]);

  const {
    harness,
    providerId,
    modelId,
    reasoningEffort,
    speedTier,
    personality,
  } = main;

  return useMemo(() => {
    if (!loaded || loaded.revision !== revision)
      return {
        label: "Loading inline discussion model…",
        error: "Wait for the provider catalog to load before asking.",
      };

    if (!loaded.catalog)
      return {
        label: "Inline discussion unavailable",
        error:
          loaded.error ??
          "Could not load providers. Reopen this conversation to retry.",
      };

    const mainSelection = {
      harness,
      providerId,
      modelId,
      reasoningEffort,
      speedTier,
      personality,
    };

    return resolveDiscussionModel(preference, loaded.catalog, mainSelection);
  }, [
    loaded,
    revision,
    preference,
    harness,
    providerId,
    modelId,
    reasoningEffort,
    speedTier,
    personality,
  ]);
}
