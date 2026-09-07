import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { commands } from "../bindings";
import { retireDaemonQueriesForIdentity } from "../daemons/errors";
import { queryKeys, unwrapCommand } from "../query";

interface SacrumConnection {
  identity: string | null;
  isLoading: boolean;
}

export function useSacrumConnection(): SacrumConnection {
  const query = useQuery({
    queryKey: queryKeys.sacrumConnection(),
    queryFn: () => unwrapCommand(commands.getSacrumConnectionIdentity()),
  });

  useEffect(() => {
    if (query.data === undefined) {
      return;
    }
    retireDaemonQueriesForIdentity(query.data);
  }, [query.data]);

  return { identity: query.data ?? null, isLoading: query.isPending };
}
