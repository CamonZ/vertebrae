import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSetFocus, mockGetByLabel, mockConstructor, MockWebviewWindow } =
  vi.hoisted(() => {
    const mockSetFocus = vi.fn();
    const mockGetByLabel = vi.fn();
    const mockConstructor = vi.fn();

    class MockWebviewWindow {
      label: string;
      options: Record<string, unknown>;
      setFocus = mockSetFocus;

      constructor(label: string, options: Record<string, unknown>) {
        this.label = label;
        this.options = options;
        mockConstructor(label, options);
      }

      static getByLabel(label: string) {
        return mockGetByLabel(label);
      }
    }

    return { mockSetFocus, mockGetByLabel, mockConstructor, MockWebviewWindow };
  });

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: MockWebviewWindow,
}));

import { popOut } from "./popOut";

describe("popOut", () => {
  beforeEach(() => {
    mockSetFocus.mockReset();
    mockGetByLabel.mockReset();
    mockConstructor.mockReset();
  });

  it("creates a new window when no window with the label exists", async () => {
    mockGetByLabel.mockResolvedValue(null);

    const result = await popOut("/popout/task/abc", "task-abc", {
      title: "Task abc",
      width: 800,
      height: 600,
    });

    expect(result.reused).toBe(false);
    expect(mockConstructor).toHaveBeenCalledTimes(1);
    const [label, options] = mockConstructor.mock.calls[0];
    expect(label).toBe("task-abc");
    expect(options).toMatchObject({
      url: "/popout/task/abc",
      title: "Task abc",
      width: 800,
      height: 600,
      focus: true,
    });
  });

  it("prepends a slash to routes that lack one", async () => {
    mockGetByLabel.mockResolvedValue(null);

    await popOut("popout/chat/xyz", "chat-xyz");

    const [, options] = mockConstructor.mock.calls[0];
    expect(options.url).toBe("/popout/chat/xyz");
  });

  it("focuses an existing window instead of creating a duplicate", async () => {
    const existing = new MockWebviewWindow("task-abc", {});
    mockConstructor.mockClear();
    mockGetByLabel.mockResolvedValue(existing);
    mockSetFocus.mockResolvedValue(undefined);

    const result = await popOut("/popout/task/abc", "task-abc");

    expect(result.reused).toBe(true);
    expect(result.window).toBe(existing);
    expect(mockSetFocus).toHaveBeenCalledTimes(1);
    expect(mockConstructor).not.toHaveBeenCalled();
  });

  it("does not focus when focus is false on reuse", async () => {
    const existing = new MockWebviewWindow("task-abc", {});
    mockConstructor.mockClear();
    mockGetByLabel.mockResolvedValue(existing);

    const result = await popOut("/popout/task/abc", "task-abc", { focus: false });

    expect(result.reused).toBe(true);
    expect(mockSetFocus).not.toHaveBeenCalled();
  });

  it("forwards arbitrary window options to WebviewWindow.create", async () => {
    mockGetByLabel.mockResolvedValue(null);

    await popOut("/popout/x", "x", {
      title: "X",
      width: 1024,
      height: 768,
      resizable: false,
    });

    const [, options] = mockConstructor.mock.calls[0];
    expect(options).toMatchObject({
      title: "X",
      width: 1024,
      height: 768,
      resizable: false,
    });
  });
});
