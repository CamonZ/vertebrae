import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { EvidenceNavigationContext } from "../../shared/EvidenceNavigationContext";
import fixture from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import { AttachmentPanel } from "./AttachmentPanel";
import {
  AttachmentRenderersContext,
  attachmentRenderers,
} from "./attachmentRenderers";
import { createFlowRegistry } from "./defaults";
import { FlowPlayer } from "./FlowPlayer";
import { compileFlowOrThrow, parseFlowSpec } from "./index";
import { FlowRegistryContext } from "./registryContext";
import type { AttachmentSpec } from "./spec";

const attachments: AttachmentSpec[] = [
  {
    kind: "note",
    text: "Ordering is significant",
    status: "verified",
    source: "trace",
  },
  {
    kind: "ref",
    path: "src/a.ts",
    line: 12,
    endLine: 16,
    claim: "Time boundary",
  },
  {
    kind: "diff",
    path: "src/b.ts",
    patch: "patch beside a range is not rendered",
    base: "abc123",
    head: "def456",
    line: 5,
    endLine: 7,
    side: "old",
  },
  { kind: "formula", expression: "distance / time", result: 1.25, unit: "m/s" },
  { kind: "payload comparison", expected: { id: 1 }, actual: { id: 2 } },
  {
    kind: "ui crop",
    image: "https://example.com/ui.png",
    rect: { x: 10, y: 20, w: 100, h: 80 },
  },
  { kind: "timing", label: "Deadline", value: 15, unit: "us" },
  { kind: "schema diff", before: "old config", after: "new config" },
  {
    kind: "test summary",
    suite: "Guard tests",
    passed: 8,
    failed: 1,
    skipped: 2,
    impacted: ["Adapter"],
  },
];

const imageArtifacts = vi.hoisted(() => ({
  artifacts: [] as { id: string; body: string }[],
}));
vi.mock("../../../hooks/useArtifactPresentations", () => ({
  useArtifactPresentations: () => ({
    ...imageArtifacts,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("../../thread/toolChange/PatchFiles", () => ({
  default: ({ patch }: { patch: string }) => (
    <pre data-testid="inline-patch">{patch}</pre>
  ),
}));
afterEach(() => {
  cleanup();
  imageArtifacts.artifacts = [];
});

it("renders every built-in with provenance and opens file ranges by keyboard", async () => {
  const open = vi.fn();

  render(
    <EvidenceNavigationContext.Provider value={open}>
      <AttachmentPanel attachments={attachments} />
    </EvidenceNavigationContext.Provider>
  );

  expect(screen.getAllByRole("listitem")).toHaveLength(10); // nine items plus impacted area
  expect(screen.getByText("verified")).toBeVisible();
  expect(screen.getByText("recorded trace")).toBeVisible();
  expect(screen.getAllByText("inferred")).toHaveLength(8);

  expect(screen.getByText(/1.25 m\/s/)).toBeVisible();
  expect(screen.getByText("Deadline:")).toHaveTextContent("15 us");
  expect(screen.getByText(/8 passed/)).toHaveTextContent(
    "1 failed · 2 skipped"
  );

  expect(screen.getByText("old config")).toBeVisible();
  expect(screen.getByText("new config")).toBeVisible();
  expect(screen.getByText("Expected")).toBeVisible();
  expect(screen.getByText("Actual")).toBeVisible();

  expect(screen.getByRole("img")).toHaveStyle({
    transform: "translate(-10px, -20px)",
  });
  expect(screen.queryByText(/patch beside a range/)).toBeNull();
  expect(screen.queryByText(/to view the source/)).toBeNull();

  screen.getByRole("button", { name: "src/a.ts:12–16" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(open).toHaveBeenLastCalledWith({
    path: "src/a.ts",
    line: 12,
    endLine: 16,
    side: "new",
  });

  fireEvent.click(screen.getByRole("button", { name: "src/b.ts:5–7" }));
  expect(open).toHaveBeenLastCalledWith({
    path: "src/b.ts",
    line: 5,
    endLine: 7,
    side: "old",
    base: "abc123",
    head: "def456",
  });
});

it("renders an inline patch in place without a checkout", async () => {
  render(
    <AttachmentPanel
      attachments={[
        {
          kind: "diff",
          patch: "--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1 @@\n-a\n+b\n",
        },
        { kind: "ref", path: "src/d.ts", line: 3 },
      ]}
    />
  );
  expect(await screen.findByTestId("inline-patch")).toHaveTextContent(
    "+++ b/src/c.ts"
  );
  expect(screen.getByRole("button", { name: "src/c.ts" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "src/d.ts:3" })).toBeDisabled();
  // Only the ref, which has nothing to show without a chat, explains why.
  expect(screen.getAllByText(/to view the source/)).toHaveLength(1);
});

it("uses a newly registered kind without changing the host", () => {
  const registry = createFlowRegistry();
  registry.attachments.register({
    kind: "impact",
    description: "Impact",
    fields: { text: { type: "string", required: true } },
  });

  render(
    <FlowRegistryContext.Provider value={registry}>
      <AttachmentRenderersContext.Provider
        value={{
          ...attachmentRenderers,
          impact: (a) => <p>Impact: {String(a.text)}</p>,
        }}
      >
        <AttachmentPanel
          attachments={[{ kind: "impact", text: "Queue drained" }]}
        />
      </AttachmentRenderersContext.Provider>
    </FlowRegistryContext.Provider>
  );

  expect(screen.getByText("Impact: Queue drained")).toBeVisible();
});

it("extends the existing inspectors and exposes flow, rail and beat evidence", () => {
  const parsed = parseFlowSpec(fixture);
  if (!parsed.ok) throw new Error("bad fixture");

  const note = (text: string) => [{ kind: "note", text }];
  const compiled = compileFlowOrThrow(parsed.value);
  const flow = {
    ...compiled,
    attachments: note("Flow evidence body"),
    cards: Object.fromEntries(
      Object.entries(compiled.cards).map(([id, card]) => [
        id,
        { ...card, attachments: note("Card evidence body") },
      ])
    ),
    arrangements: compiled.arrangements.map((d) => ({
      ...d,
      parts: d.parts.map((p) => ({ ...p, attachments: attachments })),
      rails: d.rails.map((rail) => ({
        ...rail,
        attachments: note("Rail evidence body"),
      })),
      beats: d.beats.map((b) => ({
        ...b,
        attachments: note("Beat evidence body"),
      })),
    })),
  };

  render(<FlowPlayer flow={flow} reducedMotion />);

  const player = screen.getByTestId("flow-player");
  const part = player.querySelector("g[data-part-id='process']")!;
  fireEvent.keyDown(part, { key: "Enter" });

  expect(
    within(screen.getByTestId("flow-part-inspector")).getByRole("list", {
      name: "Evidence",
    })
  ).toBeVisible();
  expect(screen.getByTestId("flow-announcer")).toHaveTextContent(
    "9 evidence items"
  );
  // Flow evidence starts collapsed; its summary opens it.
  const flowEvidence = screen.getByTestId("flow-evidence");
  expect(flowEvidence).not.toHaveAttribute("open");
  expect(
    screen.getByRole("list", { name: "Flow evidence", hidden: true })
  ).not.toBeVisible();
  fireEvent.click(within(flowEvidence).getByText("Flow evidence (1)"));
  expect(flowEvidence).toHaveAttribute("open");
  expect(screen.getByRole("list", { name: "Flow evidence" })).toBeVisible();
  fireEvent.click(within(flowEvidence).getByText("Flow evidence (1)"));
  expect(flowEvidence).not.toHaveAttribute("open");
  expect(screen.getByRole("list", { name: "Beat 1 evidence" })).toBeVisible();
  expect(screen.getAllByText("Rail evidence body").length).toBeGreaterThan(0);

  const disclosure = player.querySelector("summary")!;
  expect(fireEvent.keyDown(disclosure, { key: " " })).toBe(true);
  expect(player).toHaveAttribute("data-playing", "false");

  const card = player.querySelector("[data-card-id][role='button']")!;
  fireEvent.click(card);
  expect(
    within(screen.getByTestId("flow-card-inspector")).getByText(
      "Card evidence body"
    )
  ).toBeVisible();
});

it("resolves image artifacts, reports image failures and rejects unsafe URLs", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  imageArtifacts.artifacts = [{ id, body: "https://example.com/crop.png" }];

  const view = render(
    <AttachmentPanel attachments={[{ kind: "ui crop", image: id }]} />
  );

  const image = screen.getByRole("img");
  expect(image).toHaveAttribute("src", "https://example.com/crop.png");

  fireEvent.error(image);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Unable to load UI image"
  );

  view.rerender(
    <AttachmentPanel
      attachments={[{ kind: "ui crop", image: "javascript:alert(1)" }]}
    />
  );

  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Unsupported image reference"
  );
});
