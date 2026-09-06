import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { queryClient, queryKeys, unwrapCommand } from "../query";
import { useSacrumConnectionStore } from "../stores/sacrumConnectionStore";

interface SacrumConnection {
  /**
   * Current backend/account identity digest, or null when none has been
   * resolved yet (still loading, or no backend connected).
   */
  identity: string | null;
  /** True while the identity is being resolved for the first time. */
  isLoading: boolean;
}

/**
 * Resolves the backend/account connection identity for account-scoped server
 * state such as the daemon fleet.
 *
 * The identity is intentionally not project-scoped: switching projects on one
 * backend keeps it stable, while switching backend or account changes it, so
 * account-scoped caches can never mix accounts. On failure the identity stays
 * `null` and consumers treat their data as unavailable.
 */
export function useSacrumConnection(): SacrumConnection {
  const setIdentity = useSacrumConnectionStore((state) => state.setIdentity);
  const identity = useSacrumConnectionStore((state) => state.identity);
  const previousIdentityRef = useRef<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.sacrumConnection(),
    queryFn: () => unwrapCommand(commands.getSacrumConnectionIdentity()),
  });

  useEffect(() => {
    if (query.data === undefined) {
      return;
    }
    setIdentity(query.data);
    // When the resolved identity moves to a different backend/account, the
    // old identity's daemon subtree is retired: evict it immediately so its
    // entries do not linger for gcTime. This pairs with the project reset,
    // which preserves (rather than clears) account-scoped Sacrum queries.
    const previous = previousIdentityRef.current;
    if (query.data !== null && previous !== null && previous !== query.data) {
      void queryClient.removeQueries({
        queryKey: queryKeys.daemons.all(previous),
      });
    }
    if (query.data !== null) {
      previousIdentityRef.current = query.data;
    }
  }, [query.data, setIdentity]);

  return { identity, isLoading: query.isPending };
}
