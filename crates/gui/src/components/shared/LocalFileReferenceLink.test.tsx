import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { commands } from "../../bindings";
import { useUIStore } from "../../stores/uiStore";
import { LocalFileReferenceLink } from "./LocalFileReferenceLink";

vi.mock("../../bindings", () => ({
  commands: {
    openLocalFile: vi.fn().mockResolvedValue({ status: "ok", data: null }),
  },
}));

describe("LocalFileReferenceLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ externalEditor: "" });
  });

  it("passes the bare path, location suffix, and configured editor separately", async () => {
    const user = userEvent.setup();
    useUIStore.setState({ externalEditor: "app:/Applications/Visual Studio Code.app" });

    render(
      <LocalFileReferenceLink
        projectRoot="/repo"
        reference={{
          path: "src/main.ts",
          line: 12,
          column: 4,
        }}
      >
        src/main.ts:12:4
      </LocalFileReferenceLink>
    );

    await user.click(screen.getByTestId("local-file-reference-link"));

    expect(commands.openLocalFile).toHaveBeenCalledWith(
      "/repo",
      "src/main.ts",
      12,
      4,
      "app:/Applications/Visual Studio Code.app"
    );
  });

  it("uses the operating system handler when no editor is configured", async () => {
    const user = userEvent.setup();

    render(
      <LocalFileReferenceLink
        projectRoot="/repo"
        reference={{ path: "src/main.ts", line: null, column: null }}
      >
        src/main.ts
      </LocalFileReferenceLink>
    );

    await user.click(screen.getByTestId("local-file-reference-link"));

    expect(commands.openLocalFile).toHaveBeenCalledWith(
      "/repo",
      "src/main.ts",
      null,
      null,
      null
    );
  });
});
