import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { queryClient, queryKeys, unwrapCommand } from "../query";

interface SacrumConnection {
  identity: string | null;
  isLoading: boolean;
}

export function useSacrumConnection(): SacrumConnection {
  const previousIdentityRef = useRef<string | null>(null);

  const query = useQuery({
    queryKey: queryKeys.sacrumConnection(),
    queryFn: () => unwrapCommand(commands.getSacrumConnectionIdentity()),
  });

  useEffect(() => {
    const identity = query.data;
    if (identity === undefined) {
      return;
    }
    const previous = previousIdentityRef.current;
    if (identity !== null && previous !== null && previous !== identity) {
      void queryClient.removeQueries({
        queryKey: queryKeys.daemons.all(previous),
      });
    }
    if (identity !== null) {
      previousIdentityRef.current = identity;
    }
  }, [query.data]);

  return { identity: query.data ?? null, isLoading: query.isPending };
}
