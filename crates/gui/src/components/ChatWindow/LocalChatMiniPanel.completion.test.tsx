import { StatefulMiniPanel } from "../../test/miniPanel";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { commands } from "../../bindings";
import type { LocalChatSessionGroup } from "../../utils/localChatSessionGroups";

vi.mock("../../bindings", () => ({
  commands: { getTask: vi.fn(), listWorkflows: vi.fn() },
}));

const sessions: LocalChatSessionGroup["sessions"] = [
  "associated",
  "general",
].map((id) => ({
  id,
  label: id,
  title: id,
  harness: "claude",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  projectPath: "/foreign",
  providerResumeId: null,
  messageCount: 1,
  lifecycle: "idle",
  association:
    id === "associated" ? { ticketId: "ticket", ticketTitle: "Work" } : null,
}));

const group: LocalChatSessionGroup = {
  id: "foreign",
  label: "Foreign",
  projectId: "foreign",
  projectPath: "/foreign",
  isCurrentProject: false,
  isFallback: false,
  sessions,
};

const onSelect = vi.fn();
const onDelete = vi.fn();

const props = {
  width: 320,
  activeSessionId: "associated",
  searchQuery: "",
  onSearchQueryChange: vi.fn(),
  selectedProjectId: "foreign",
  onSelectProject: vi.fn(),
  deleteError: null,
  projectWarning: null,
  sessionGroups: [group],
  spawnOutlineBySessionId: new Map(),
  activityBySessionId: new Map([["associated", "thinking" as const]]),
  onSelect,
  onDelete,
};

it("renders associated and unlinked catalog summaries without reading tasks or workflows", () => {
  render(<StatefulMiniPanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Work" }));
  expect(
    screen.getByRole("button", { name: /Load local chat associated/ })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /Load local chat general/ })
  ).toBeInTheDocument();
  expect(commands.getTask).not.toHaveBeenCalled();
  expect(commands.listWorkflows).not.toHaveBeenCalled();
});
