import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { parseRunChatHash, useRunChatDeepLink } from "./useRunChatDeepLink";

const mocks = vi.hoisted(() => ({
  openRunInChat: vi.fn(),
  resolveTaskRunTarget: vi.fn(),
}));
vi.mock("../utils/openRunInChat", () => mocks);

let currentHash = "";
function Probe() {
  useRunChatDeepLink();
  currentHash = useLocation().hash;
  return null;
}

function renderAt(entry: string) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Probe />
    </MemoryRouter>
  );
}

describe("useRunChatDeepLink", () => {
  beforeEach(() => {
    mocks.openRunInChat.mockReset();
    mocks.resolveTaskRunTarget.mockReset();
  });

  it("parses task, run and exec hash params", () => {
    expect(parseRunChatHash("#task=t1&run=r1&exec=e1")).toEqual({
      taskId: "t1",
      runId: "r1",
      threadId: "e1",
    });
    expect(parseRunChatHash("#exec=e1")).toBeNull();
    expect(parseRunChatHash("")).toBeNull();
  });

  it("opens the named run scrolled to the exec thread and clears the hash", async () => {
    renderAt("/tasks#task=t1&run=r1&exec=e1");

    await waitFor(() =>
      expect(mocks.openRunInChat).toHaveBeenCalledWith({
        taskId: "t1",
        runId: "r1",
        threadId: "e1",
      })
    );
    expect(currentHash).toBe("");
    expect(mocks.resolveTaskRunTarget).not.toHaveBeenCalled();
  });

  it("resolves the task's run when no run is given", async () => {
    mocks.resolveTaskRunTarget.mockResolvedValue({
      taskId: "t1",
      runId: "r-latest",
    });

    renderAt("/settings#task=t1");

    await waitFor(() =>
      expect(mocks.openRunInChat).toHaveBeenCalledWith({
        taskId: "t1",
        runId: "r-latest",
        threadId: null,
      })
    );
  });

  it("ignores unrelated hashes", () => {
    renderAt("/settings#section");
    expect(mocks.openRunInChat).not.toHaveBeenCalled();
    expect(currentHash).toBe("#section");
  });
});
