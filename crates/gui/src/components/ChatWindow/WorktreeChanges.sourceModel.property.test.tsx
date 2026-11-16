import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { WorktreeChanges } from "./WorktreeChanges";
import {
  commands,
  type FileBody,
  type WorktreeChanges as Changes,
} from "../../bindings";
import { useDocumentStore } from "./workspace/documentStore";
import type {
  AllChangesViewProps,
  JumpTarget,
} from "./workspace/AllChangesView";
import type { DocumentEditorProps } from "./workspace/DocumentEditor";
import {
  filePatch,
  numbered,
} from "../thread/toolChange/diffPatchBuilder.test.helpers";

vi.mock("./workspace/useWorktreeWatch", () => ({
  useWorktreeWatch: vi.fn(() => null),
}));
vi.mock("../../bindings", () => ({
  commands: {
    loadWorktreeChanges: vi.fn(),
    listComparisonChoices: vi
      .fn()
      .mockResolvedValue({ status: "ok", data: [] }),
    listWorktreeDirectory: vi.fn().mockResolvedValue({
      status: "ok",
      data: { path: "", entries: [], truncated: false },
    }),
    worktreeFileExists: vi.fn().mockResolvedValue({ status: "ok", data: true }),
    readWorktreeFile: vi.fn(),
    readWorktreeBaselineFile: vi.fn(),
    saveWorktreeFile: vi.fn(),
  },
}));
// Pierre stand-ins exposing what the workspace asks them to show.
vi.mock("./workspace/AllChangesView", () => ({
  default: ({ files, jumpTarget }: AllChangesViewProps) => (
    <div data-testid="all-diffs">
      {files.map((file) => (
        <section key={file.path} aria-label={`Diff for ${file.path}`} />
      ))}
      <output aria-label="Jump target" data-nonce={jumpTarget?.nonce ?? ""}>
        {jumpTarget?.path ?? ""}
      </output>
    </div>
  ),
}));
vi.mock("./workspace/DocumentEditor", () => ({
  default: ({
    path,
    view,
    contents,
    onChange,
    reveal,
    onRevealed,
  }: DocumentEditorProps) => (
    <div
      data-testid="document-editor"
      data-view={view}
      data-path={path}
      data-reveal={reveal ? `${reveal.line}-${reveal.endLine}` : ""}
      data-scrolled={reveal?.scrolled ? "true" : "false"}
    >
      {reveal && !reveal.scrolled && (
        <button type="button" onClick={() => onRevealed?.()}>
          Finish reveal
        </button>
      )}
      <textarea
        aria-label={`Edit ${path}`}
        defaultValue={contents ?? ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  ),
}));

const load = vi.mocked(commands.loadWorktreeChanges);
const read = vi.mocked(commands.readWorktreeFile);
const readBaseline = vi.mocked(commands.readWorktreeBaselineFile);
const save = vi.mocked(commands.saveWorktreeFile);

const APP = "src/app.ts";
const UTIL = "src/util.ts";
const BEFORE = numbered("l", 12);
// Only line 5 changes; lines 8–9 stay as they were.
const AFTER = [...BEFORE.slice(0, 4), "changed", ...BEFORE.slice(5)];
const comparison = {
  base_commit: "base-sha",
  selected_base_commit: "base-sha",
  target_commit: "head-sha",
  working_tree: true,
  merge_base: true,
};
// The past commit has no changes, so routing on it would misplace references.
const changes = (workingTree: boolean): Changes => ({
  base_branch: "refs/heads/main",
  base_unavailable: null,
  comparison: { ...comparison, working_tree: workingTree },
  totals: { additions: 1, deletions: 1, binary_files: 0 },
  files: !workingTree
    ? []
    : [
        {
          path: APP,
          old_path: null,
          status: "modified",
          marker: null,
          totals: { additions: 1, deletions: 1, binary_files: 0 },
          patch: filePatch({ path: APP, before: BEFORE, after: AFTER }),
        },
      ],
});

type Reference = "changed" | "unchanged range" | "unchanged file";
const REFERENCES: Record<Reference, Omit<JumpTarget, "nonce">> = {
  changed: { path: APP, line: 5, endLine: 5 },
  "unchanged range": { path: APP, line: 8, endLine: 9 },
  "unchanged file": { path: UTIL, line: 1, endLine: 2 },
};

/** What the user should see, maintained independently of the component. */
interface Model {
  rerender(sourceJump: JumpTarget): void;
  /** Rules applied so far, for reporting a divergence. */
  steps: string[];
  nonce: number;
  edits: number;
  /** Showing a past-commit comparison, and whether its load fails. */
  historical: boolean;
  historicalFails: boolean;
  explorerOpen: boolean;
  view: { kind: "all" } | { kind: "file"; path: string };
  /** The last diff jump All Changes was given. */
  jump: { path: string; nonce: number } | null;
  reveal: {
    path: string;
    line: number;
    endLine: number;
    scrolled: boolean;
  } | null;
  drafts: Map<string, string>;
  disk: Record<string, FileBody>;
}

const text = (contents: string, revision: string): FileBody => ({
  kind: "text",
  contents,
  revision,
});

function workspace() {
  return useDocumentStore.getState().workspaces["/worktree"];
}

function expectModel(m: Model) {
  const toggle = screen.getByRole("button", {
    name: m.explorerOpen ? "Hide files" : "Show files",
  });
  expect(toggle).toHaveAttribute("aria-expanded", String(m.explorerOpen));

  // Drafts are never lost, whatever is on screen.
  for (const [path, draft] of m.drafts)
    expect(workspace()?.documents[path]?.draft).toBe(draft);

  if (m.historical) {
    expect(screen.queryByTestId("document-editor")).toBeNull();
    if (m.historicalFails)
      expect(screen.getByRole("alert")).toHaveTextContent("no commit");
    else
      expect(screen.getByRole("status", { name: "No changes" })).toBeVisible();
    return;
  }

  if (m.view.kind === "all") {
    expect(workspace()?.active ?? null).toBeNull();
    expect(screen.queryByTestId("document-editor")).toBeNull();
    const jump = screen.getByRole("status", { name: "Jump target" });
    expect(jump).toHaveTextContent(m.jump?.path ?? "");
    expect(jump).toHaveAttribute("data-nonce", String(m.jump?.nonce ?? ""));
    return;
  }

  const { path } = m.view;
  expect(workspace()?.active).toBe(path);
  const editor = screen.getByTestId("document-editor");
  expect(editor).toHaveAttribute("data-path", path);
  expect(editor).toHaveAttribute("data-view", "file");
  const reveal = m.reveal?.path === path ? m.reveal : null;
  expect(editor).toHaveAttribute(
    "data-reveal",
    reveal ? `${reveal.line}-${reveal.endLine}` : ""
  );
  expect(editor).toHaveAttribute(
    "data-scrolled",
    reveal?.scrolled ? "true" : "false"
  );
  const draft = m.drafts.get(path);
  if (draft !== undefined)
    expect(screen.getByRole("textbox", { name: `Edit ${path}` })).toHaveValue(
      draft
    );
}

/** Rules that ran past their assumptions, across all test cases. */
const ran = new Map<string, number>();
function count(m: Model, rule: string, detail = "") {
  ran.set(rule, (ran.get(rule) ?? 0) + 1);
  m.steps.push(detail ? `${rule} (${detail})` : rule);
}
/**
 * The first divergence seen. Shrinking a UI machine can outlast the test
 * timeout, so the test fails with this unshrunk trace at its deadline.
 */
let firstFailure: string | null = null;
let aborted = false;
/** References made while a past commit was shown, by whether it failed. */
const raced = { failed: 0, loaded: 0 };

const settle = async (m: Model) => {
  await act(async () => {});
  // Short: the component settles in a few ticks, and a divergence then fails
  // quickly enough to shrink.
  try {
    await waitFor(() => expectModel(m), { timeout: 100 });
  } catch (error) {
    firstFailure ??= `${m.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n${String(error)}`;
    throw error;
  }
};

/** Saves the shown document's draft; the saved file reloads its editor. */
async function saveShown(m: Model) {
  const path = (m.view as { path: string }).path;
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  m.drafts.delete(path);
  await waitFor(() => expect(workspace()?.documents[path]?.draft).toBeNull());
  count(m, "save");
  await settle(m);
}

const editable = (m: Model) => !m.historical && m.view.kind === "file";

const machine: hegel.stateful.StateMachine<Model> = {
  rules: {
    async reference(tc, m) {
      const kind = tc.draw(
        gs.sampledFrom<Reference>([
          "changed",
          "unchanged range",
          "unchanged file",
        ])
      );
      const target = { ...REFERENCES[kind], nonce: ++m.nonce };
      if (m.historical) raced[m.historicalFails ? "failed" : "loaded"]++;
      m.rerender(target);
      // A reference returns to the working copy beside a collapsed explorer.
      m.historical = false;
      m.explorerOpen = false;
      if (kind === "changed") {
        m.view = { kind: "all" };
        m.jump = { path: target.path, nonce: target.nonce };
        m.reveal = null;
      } else {
        m.view = { kind: "file", path: target.path };
        m.jump = null;
        m.reveal = {
          path: target.path,
          line: target.line!,
          endLine: target.endLine!,
          scrolled: false,
        };
      }
      count(m, "reference", kind);
      await settle(m);
    },
    async toggleExplorer(_tc, m) {
      fireEvent.click(
        screen.getByRole("button", {
          name: m.explorerOpen ? "Hide files" : "Show files",
        })
      );
      m.explorerOpen = !m.explorerOpen;
      count(m, "toggleExplorer");
      await settle(m);
    },
    async finishReveal(tc, m) {
      tc.assume(
        editable(m) &&
          m.view.kind === "file" &&
          m.reveal?.path === m.view.path &&
          !m.reveal.scrolled
      );
      fireEvent.click(screen.getByRole("button", { name: "Finish reveal" }));
      m.reveal!.scrolled = true;
      count(m, "finishReveal");
      await settle(m);
    },
    async edit(tc, m) {
      tc.assume(editable(m));
      const path = (m.view as { path: string }).path;
      const draft = `draft ${++m.edits}`;
      fireEvent.change(screen.getByRole("textbox", { name: `Edit ${path}` }), {
        target: { value: draft },
      });
      m.drafts.set(path, draft);
      // Editing ends the reference's highlight.
      m.reveal = null;
      count(m, "edit");
      await settle(m);
      // Saving needs a draft in the shown document, which a separate rule
      // would rarely find, so an edit is often saved straight away.
      if (tc.draw(gs.booleans())) await saveShown(m);
    },
    async save(tc, m) {
      tc.assume(editable(m));
      tc.assume(m.drafts.has((m.view as { path: string }).path));
      await saveShown(m);
    },
    async allChanges(_tc, m) {
      fireEvent.click(screen.getByRole("button", { name: "All changes" }));
      if (!m.historical) m.view = { kind: "all" };
      m.reveal = null;
      count(m, "allChanges");
      await settle(m);
    },
    async pastCommit(tc, m) {
      tc.assume(!m.historical);
      m.historicalFails = tc.draw(gs.booleans());
      fireEvent.click(
        screen.getByRole("combobox", { name: "Comparison target" })
      );
      const option = screen
        .getAllByRole("option")
        .find((item) => item.getAttribute("data-value") === "head");
      fireEvent.click(option!);
      m.historical = true;
      count(m, "pastCommit");
      await settle(m);
    },
  },
};

beforeEach(() => {
  useDocumentStore.setState({ workspaces: {} });
});

/** Report a divergence this long after starting, even mid-shrink. */
const DEADLINE_MS = 90_000;

test(
  "generated reference, explorer, edit and comparison sequences match the navigation model",
  async () => {
    const run = hegel
      .testAsync(
        async (tc) => {
          // Once the deadline has reported a divergence, let shrinking finish.
          if (aborted) return;
          useDocumentStore.setState({ workspaces: {} });
          const m: Model = {
            rerender: () => {},
            steps: [],
            nonce: 0,
            edits: 0,
            historical: false,
            historicalFails: false,
            explorerOpen: true,
            view: { kind: "all" },
            jump: null,
            reveal: null,
            drafts: new Map(),
            disk: {
              [APP]: text(AFTER.join("\n") + "\n", "a1"),
              [UTIL]: text("one\ntwo\nthree\n", "u1"),
            },
          };
          load.mockReset();
          load.mockImplementation(async (_path, request) =>
            request.target.kind === "working_tree"
              ? { status: "ok", data: changes(true) }
              : m.historicalFails
                ? ({
                    status: "error",
                    error: { message: "no commit" },
                  } as never)
                : { status: "ok", data: changes(false) }
          );
          read.mockReset();
          read.mockImplementation(async (_worktree, path) => ({
            status: "ok",
            data: m.disk[path] ?? { kind: "missing" },
          }));
          readBaseline.mockReset();
          readBaseline.mockResolvedValue({
            status: "ok",
            data: text(BEFORE.join("\n") + "\n", "b1"),
          });
          save.mockReset();
          save.mockImplementation(async (_worktree, path, contents) => {
            m.disk[path] = text(contents, `saved:${contents}`);
            return {
              status: "ok",
              data: { kind: "saved", revision: `saved:${contents}` },
            };
          });

          const view = render(<WorktreeChanges worktreePath="/worktree" />);
          m.rerender = (sourceJump) =>
            view.rerender(
              <WorktreeChanges
                worktreePath="/worktree"
                sourceJump={sourceJump}
              />
            );
          try {
            await screen.findByLabelText(`Diff for ${APP}`);
            await settle(m);
            await hegel.stateful.runAsync(tc, machine, m, { stepCount: 20 });
          } finally {
            view.unmount();
          }
        },
        { testCases: 50 }
      )
      .then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), DEADLINE_MS);
    });
    const finished = await Promise.race([run, deadline]).finally(() =>
      clearTimeout(timer)
    );
    if (!finished) {
      aborted = true;
      await run.catch(() => {});
      throw new Error(
        firstFailure
          ? `Navigation model diverged (unshrunk; shrinking hit the deadline):\n${firstFailure}`
          : "Navigation model test hit its deadline without a divergence"
      );
    }
    // Every rule ran, and references followed both kinds of past commit.
    for (const rule of Object.keys(machine.rules))
      expect(ran.get(rule) ?? 0, rule).toBeGreaterThan(0);
    expect(raced.failed).toBeGreaterThan(0);
    expect(raced.loaded).toBeGreaterThan(0);
  },
  DEADLINE_MS + 30_000
);
