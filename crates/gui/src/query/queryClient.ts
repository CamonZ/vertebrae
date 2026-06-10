import { QueryClient } from "@tanstack/react-query";

export const SERVER_STATE_STALE_TIME_MS = Infinity;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: SERVER_STATE_STALE_TIME_MS,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    },
  },
});
