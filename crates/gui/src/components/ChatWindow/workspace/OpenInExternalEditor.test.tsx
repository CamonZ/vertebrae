import { beforeEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { commands } from "../../../bindings";
import { useUIStore } from "../../../stores/uiStore";
import { OpenInExternalEditor } from "./OpenInExternalEditor";

vi.mock("../../../bindings", () => ({
  commands: { openLocalFile: vi.fn(), worktreeFileExists: vi.fn() },
}));

beforeEach(() => {
  vi.resetAllMocks();
  useUIStore.setState({ externalEditor: "command:code" });
  vi.mocked(commands.openLocalFile).mockResolvedValue({
    status: "ok",
    data: null,
  });
  vi.mocked(commands.worktreeFileExists).mockResolvedValue({
    status: "ok",
    data: true,
  });
});

it("forwards effective worktree and location through the app's current editor setting", async () => {
  const view = render(
    <OpenInExternalEditor
      root="/main"
      path="src/a.ts"
      line={12}
      column={3}
      available
    />
  );

  await userEvent.click(screen.getByRole("button"));

  expect(commands.openLocalFile).toHaveBeenCalledExactlyOnceWith(
    "/main",
    "src/a.ts",
    12,
    3,
    "command:code"
  );

  useUIStore.setState({ externalEditor: "command:zed" });

  view.rerender(
    <OpenInExternalEditor root="/feature" path="src/a.ts" line={7} available />
  );
  await userEvent.click(screen.getByRole("button"));

  expect(commands.openLocalFile).toHaveBeenLastCalledWith(
    "/feature",
    "src/a.ts",
    7,
    null,
    "command:zed"
  );
});

it("uses existing default behavior without an editor setting and reports launch failure", async () => {
  useUIStore.setState({ externalEditor: "" });
  vi.mocked(commands.openLocalFile).mockResolvedValue({
    status: "error",
    error: { message: "Editor launch failed" },
  });

  render(<OpenInExternalEditor root="/main" path="src/a.ts" available />);
  await userEvent.click(screen.getByRole("button"));

  expect(commands.openLocalFile).toHaveBeenCalledExactlyOnceWith(
    "/main",
    "src/a.ts",
    null,
    null,
    null
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Editor launch failed");
});

it("disables historical-local-file actions when the corresponding file is missing", async () => {
  vi.mocked(commands.worktreeFileExists).mockResolvedValue({
    status: "ok",
    data: false,
  });

  render(<OpenInExternalEditor root="/main" path="deleted.ts" />);
  await waitFor(() =>
    expect(commands.worktreeFileExists).toHaveBeenCalledWith(
      "/main",
      "deleted.ts"
    )
  );

  expect(screen.getByRole("button")).toBeDisabled();
  expect(screen.getByRole("button")).toHaveAttribute(
    "title",
    expect.stringContaining("unavailable")
  );
  expect(commands.openLocalFile).not.toHaveBeenCalled();
});

it("shares one in-flight launch and retires errors after the displayed file changes", async () => {
  let finish!: (
    result: Awaited<ReturnType<typeof commands.openLocalFile>>
  ) => void;
  vi.mocked(commands.openLocalFile).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const view = render(
    <OpenInExternalEditor root="/feature" path="a.ts" available />
  );

  await userEvent.dblClick(screen.getByRole("button"));

  expect(commands.openLocalFile).toHaveBeenCalledTimes(1);

  view.rerender(<OpenInExternalEditor root="/main" path="b.ts" available />);
  await userEvent.click(screen.getByRole("button"));

  expect(commands.openLocalFile).toHaveBeenCalledTimes(2);

  finish({ status: "error", error: { message: "Old file's editor failed" } });
  await waitFor(() => expect(screen.getByRole("button")).toBeEnabled());

  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("reports normal availability errors and immediately derives explicit availability", async () => {
  vi.mocked(commands.worktreeFileExists).mockResolvedValue({
    status: "error",
    error: { message: "Permission denied" },
  });
  const view = render(<OpenInExternalEditor root="/feature" path="a.ts" />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Permission denied"
  );
  view.rerender(<OpenInExternalEditor root="/feature" path="a.ts" available />);
  expect(screen.getByRole("button")).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
