import { describe, expect, it } from "vitest";
import { queryClient, SERVER_STATE_STALE_TIME_MS } from "./queryClient";

describe("queryClient", () => {
  it("uses websocket-friendly server-state defaults", () => {
    const options = queryClient.getDefaultOptions().queries;

    expect(SERVER_STATE_STALE_TIME_MS).toBe(Infinity);
    expect(options?.staleTime).toBe(Infinity);
    expect(options?.refetchOnWindowFocus).toBe(false);
    expect(options?.refetchOnReconnect).toBe(false);
    expect(options?.retry).toBe(false);
  });
});
