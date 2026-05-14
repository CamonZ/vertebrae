import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPopOut = vi.hoisted(() => vi.fn());
vi.mock("./popOut", () => ({
  popOut: mockPopOut,
}));

const mockSetPanelOpen = vi.hoisted(() => vi.fn());
vi.mock("../stores/liveChatStore", () => ({
  useLiveChatStore: {
    getState: () => ({ setPanelOpen: mockSetPanelOpen }),
  },
}));

import { detachLiveChat } from "./detachLiveChat";

describe("detachLiveChat", () => {
  beforeEach(() => {
    mockPopOut.mockReset();
    mockSetPanelOpen.mockReset();
  });

  it("opens (or focuses) the live-chat window with the expected options and closes the embedded panel", async () => {
    mockPopOut.mockResolvedValueOnce({ window: {}, reused: false });

    await detachLiveChat();

    expect(mockPopOut).toHaveBeenCalledTimes(1);
    const [route, label, opts] = mockPopOut.mock.calls[0];
    expect(route).toBe("/live-chat");
    expect(label).toBe("live-chat");
    expect(opts).toEqual({
      title: "Live Chat",
      width: 480,
      height: 720,
    });
    expect(mockSetPanelOpen).toHaveBeenCalledWith(false);
  });

  it("still closes the embedded panel when the window is reused", async () => {
    mockPopOut.mockResolvedValueOnce({ window: {}, reused: true });

    await detachLiveChat();

    expect(mockSetPanelOpen).toHaveBeenCalledWith(false);
  });
});
