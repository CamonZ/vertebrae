import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { save } from "@tauri-apps/plugin-dialog";
import { commands } from "../bindings";
import { useDebugStore } from "../stores/debugStore";
import { DebugConsole } from "./DebugConsole";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

vi.mock("../bindings", () => ({
  commands: {
    writeDebugExport: vi.fn(),
  },
}));

describe("DebugConsole export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDebugStore.setState({
      debugPanelOpen: true,
      logs: [
        {
          timestamp: 1,
          level: "INFO",
          crateName: "gui",
          message: "hello",
        },
      ],
      traces: [],
    });
  });

  it("saves the retained diagnostic payload to the selected path", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/vertebrae-debug.json");
    vi.mocked(commands.writeDebugExport).mockResolvedValue({
      status: "ok",
      data: null,
    });

    render(<DebugConsole />);
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));

    await waitFor(() => expect(commands.writeDebugExport).toHaveBeenCalled());

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: expect.stringMatching(/^vertebrae-debug-.*\.json$/),
        filters: [{ name: "JSON", extensions: ["json"] }],
      })
    );
    expect(commands.writeDebugExport).toHaveBeenCalledWith(
      "/tmp/vertebrae-debug.json",
      expect.stringContaining('"schema_version": 1')
    );
  });

  it("shows an error when writing the selected file fails", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/vertebrae-debug.json");
    vi.mocked(commands.writeDebugExport).mockResolvedValue({
      status: "error",
      error: { message: "permission denied" },
    });

    render(<DebugConsole />);
    fireEvent.click(screen.getByRole("button", { name: "Export JSON" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Export failed: permission denied"
    );
  });
});
