import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { queryClient, queryKeys, unwrapCommand } from "../query";
import { useSacrumConnectionStore } from "../stores/sacrumConnectionStore";

interface SacrumConnection {
  identity: string | null;
  isLoading: boolean;
}

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
