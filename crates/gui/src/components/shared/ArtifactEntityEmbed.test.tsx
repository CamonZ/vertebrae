import { readFileSync } from "node:fs";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Artifact } from "../../bindings";
import { resetProjectScopedStores } from "../../stores/projectScopedStores";
import { queryClient } from "../../query/queryClient";
import { MarkdownContent } from "./MarkdownContent";
import {
  layoutStatechart,
  type StatechartLayout,
} from "../Artifacts/statechartLayout";
import { parseStatechart, type Statechart } from "../Artifacts/statechart";

const list = vi.hoisted(() => vi.fn());

vi.mock("../../bindings", () => ({
  commands: { listArtifactPresentations: list },
}));

vi.mock("../Artifacts/statechartLayout", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../Artifacts/statechartLayout")>();

  return {
    ...actual,
    layoutStatechart: vi.fn(
      async (machine: Statechart): Promise<StatechartLayout> => {
        const states = machine.nodes.map((node, index) => ({
          ...node,
          x: 10,
          y: index * 80,
          width: 210,
          height: 72,
          region: false,
        }));

        return {
          width: 500,
          height: 1000,
          states,
          transitions: [],
          initials: [],
        };
      }
    ),
  };
});

const doc = readFileSync(
  "../../docs/agent-context/statecharts-example.md",
  "utf8"
);
const jsonMatches = doc.matchAll(/```json\n([\s\S]*?)\n```/g);
const matches = [...jsonMatches];
const blocks = matches.map((match) => match[1]);
const documentedMetadata = JSON.parse(blocks[1]);
const ids = [
  "860cde1b-9093-42ff-a19d-7453f3b7891b",
  "860cde1b-9093-42ff-a19d-7453f3b7891c",
  "860cde1b-9093-42ff-a19d-7453f3b7891d",
];

const markdown = (ref: number) => `[Chart ${ref}](vtb://artifact/${ids[ref]})`;

function artifact(
  ref = 0,
  scope = 0,
  overrides: Partial<Artifact> = {}
): Artifact {
  const definition = JSON.parse(blocks[0]);
  const machine = { ...definition, description: `scope-${scope}-ref-${ref}` };
  const body = JSON.stringify(machine);
  const metadata = JSON.parse(blocks[1]);

  return {
    id: ids[ref],
    project_id: `project-${scope}`,
    filename: "workflow.statechart.json",
    logical_name: "workflow-statechart",
    created_at: null,
    updated_at: null,
    body,
    metadata,
    ...overrides,
  };
}

beforeEach(() => {
  list.mockReset();
  resetProjectScopedStores();
});

it("dispatches the published example through real Markdown, keeping the artifact reference", async () => {
  const publishedArtifact = artifact(0, 0, { body: blocks[0] });
  const response = { status: "ok", data: [publishedArtifact] };
  const reference = markdown(0);

  list.mockResolvedValue(response);
  render(<MarkdownContent text={reference} />);

  const title = await screen.findByText("Ticket delivery");
  const diagram = await screen.findByRole("group", {
    name: "Ticket delivery statechart",
  });
  const link = screen.getByRole("link");

  expect(title).toBeInTheDocument();
  expect(diagram.tagName.toLowerCase()).toBe("svg");
  expect(screen.queryByTitle("Mermaid diagram")).toBeNull();
  expect(link).toHaveAttribute("data-vtb-entity-id", ids[0]);
});

it.each([
  null,
  { ...documentedMetadata, content_kind: "document" },
  { ...documentedMetadata, presentation: "raw" },
  { ...documentedMetadata, version: 2 },
])("keeps ordinary artifact metadata as a link (%#)", async (metadata) => {
  const ordinaryArtifact = artifact(0, 0, { metadata });
  const response = { status: "ok", data: [ordinaryArtifact] };
  const reference = markdown(0);

  list.mockResolvedValue(response);
  render(<MarkdownContent text={reference} />);
  await waitFor(() => expect(list).toHaveBeenCalledOnce());

  const chart = screen.queryByTestId("statechart-preview");
  const link = screen.getByRole("link");

  expect(chart).toBeNull();
  expect(link).toBeInTheDocument();
});

it("keeps missing artifacts and malformed statecharts readable without breaking adjacent Markdown", async () => {
  const malformedArtifact = artifact(0, 0, { body: '{"actions":[]}' });
  const response = { status: "ok", data: [malformedArtifact] };
  const malformedReference = markdown(0);
  const missingReference = markdown(1);
  const content = `${malformedReference} ${missingReference} **Still readable**`;

  list.mockResolvedValue(response);
  render(<MarkdownContent text={content} />);

  const alert = await screen.findByRole("alert");
  const links = screen.getAllByRole("link");
  const adjacentContent = screen.getByText("Still readable");

  expect(alert).toHaveTextContent("Unsupported XState field: actions");
  expect(links).toHaveLength(2);
  expect(adjacentContent).toBeInTheDocument();
});

it("offers an explicit retry after failure", async () => {
  const error = new Error("offline");
  const loadedArtifact = artifact();
  const response = { status: "ok", data: [loadedArtifact] };
  const reference = markdown(0);

  list.mockRejectedValueOnce(error).mockResolvedValueOnce(response);
  render(<MarkdownContent text={reference} />);

  const retry = await screen.findByRole("button", { name: "Retry artifact" });

  fireEvent.click(retry);

  const title = await screen.findByText("scope-0-ref-0");

  expect(title).toBeInTheDocument();
});

it("retires an in-flight native layout when the artifact reference changes", async () => {
  let oldRender!: (layout: StatechartLayout) => void;
  let newRender!: (layout: StatechartLayout) => void;
  const renderer = vi.mocked(layoutStatechart);
  const defaultLayout = renderer.getMockImplementation()!;
  const renderOldDiagram = () =>
    new Promise<StatechartLayout>((resolve) => {
      oldRender = resolve;
    });
  const renderNewDiagram = () =>
    new Promise<StatechartLayout>((resolve) => {
      newRender = resolve;
    });

  renderer
    .mockImplementationOnce(renderOldDiagram)
    .mockImplementationOnce(renderNewDiagram);

  const firstArtifact = artifact(0);
  const secondArtifact = artifact(1);
  const firstMachine = parseStatechart(firstArtifact.body);
  const secondMachine = parseStatechart(secondArtifact.body);
  const firstLayout = await defaultLayout(firstMachine);
  const secondLayout = await defaultLayout(secondMachine);
  const retiredLayout = { ...firstLayout, width: 333 };
  const currentLayout = { ...secondLayout, width: 777 };
  const response = { status: "ok", data: [firstArtifact, secondArtifact] };
  const firstReference = markdown(0);
  const secondReference = markdown(1);

  list.mockResolvedValue(response);

  const ui = render(<MarkdownContent text={firstReference} />);
  await waitFor(() => expect(oldRender).toBeDefined());

  ui.rerender(<MarkdownContent text={secondReference} />);
  await waitFor(() => expect(newRender).toBeDefined());
  await act(async () => newRender(currentLayout));

  const currentDiagram = screen.getByRole("group", {
    name: "scope-0-ref-1 statechart",
  });

  expect(currentDiagram).toHaveAttribute("viewBox", "0 0 777 1000");

  await act(async () => oldRender(retiredLayout));

  const afterRetiredResponse = screen.getByRole("group", {
    name: "scope-0-ref-1 statechart",
  });
  const retiredTitle = screen.queryByText("scope-0-ref-0");

  expect(afterRetiredResponse).toHaveAttribute("viewBox", "0 0 777 1000");
  expect(retiredTitle).toBeNull();
});

// Independent lifecycle model. The backend projection is shared per project;
// each embed owns its current reference, mount lifetime and rendered selection.
it(
  "model: generated reference, project, request, failure, retry and unmount schedules never show stale content",
  () =>
    hegel.testAsync(
      async (tc) => {
        const kindGenerator = gs.sampledFrom([
          "replace",
          "project",
          "success",
          "failure",
          "retry",
          "unmount",
          "mount",
        ] as const);
        const slotGenerator = gs.integers({ minValue: 0, maxValue: 1 });
        const referenceGenerator = gs.integers({ minValue: 0, maxValue: 2 });
        const requestGenerator = gs.integers({ minValue: 0, maxValue: 20 });
        const actionGenerator = gs.record({
          kind: kindGenerator,
          slot: slotGenerator,
          ref: referenceGenerator,
          request: requestGenerator,
        });
        const actionsGenerator = gs.arrays(actionGenerator, {
          minSize: 1,
          maxSize: 24,
        });
        const actions = tc.draw(actionsGenerator);

        queryClient.clear();
        resetProjectScopedStores();

        let scope = 0;
        const requests: {
          scope: number;
          settled: boolean;
          resolve: (value: { status: "ok"; data: Artifact[] }) => void;
          reject: (error: Error) => void;
        }[] = [];
        const outcomes = new Map<number, "rendered" | "fallback">();

        const loadArtifacts = () =>
          new Promise<{ status: "ok"; data: Artifact[] }>((resolve, reject) => {
            requests.push({ scope, settled: false, resolve, reject });
          });

        list.mockImplementation(loadArtifacts);

        const owners = [
          { mounted: true, ref: 0 },
          { mounted: true, ref: 1 },
        ];
        const view = () => (
          <>
            {owners.map((owner, index) => {
              const reference = markdown(owner.ref);

              return (
                <section key={index} data-testid={`owner-${index}`}>
                  {owner.mounted && <MarkdownContent text={reference} />}
                </section>
              );
            })}
          </>
        );

        vi.useFakeTimers();

        const initialView = view();
        const ui = render(initialView);
        const flush = async () => {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
          });
        };

        try {
          await flush();

          // Mandatory adversarial prefix ensures out-of-order old scope responses and
          // reference replacement are exercised even when generated actions are short.
          const script = [
            { kind: "replace", slot: 0, ref: 1, request: 0 },
            { kind: "project", slot: 0, ref: 0, request: 0 },
            { kind: "unmount", slot: 1, ref: 0, request: 0 },
            { kind: "success", slot: 0, ref: 0, request: 1 },
            { kind: "success", slot: 0, ref: 0, request: 0 },
            { kind: "mount", slot: 1, ref: 0, request: 0 },
            ...actions,
          ];

          for (const action of script) {
            await act(async () => {
              const owner = owners[action.slot];

              if (action.kind === "replace") owner.ref = action.ref;
              if (action.kind === "unmount") owner.mounted = false;
              if (action.kind === "mount") owner.mounted = true;

              if (action.kind === "project") {
                scope++;
                resetProjectScopedStores();
              }

              if (action.kind === "success" || action.kind === "failure") {
                const request = requests[action.request % requests.length];
                if (request && !request.settled) {
                  request.settled = true;
                  const outcome =
                    action.kind === "success" ? "rendered" : "fallback";

                  outcomes.set(request.scope, outcome);

                  if (action.kind === "success") {
                    const firstArtifact = artifact(0, request.scope);
                    const secondArtifact = artifact(1, request.scope);
                    const originalMetadata = JSON.parse(blocks[1]);
                    const metadata = {
                      ...originalMetadata,
                      content_kind: "document",
                    };
                    const ordinaryArtifact = artifact(2, request.scope, {
                      metadata,
                    });
                    const response = {
                      status: "ok" as const,
                      data: [firstArtifact, secondArtifact, ordinaryArtifact],
                    };

                    request.resolve(response);
                  } else {
                    const error = new Error("fixture failure");

                    request.reject(error);
                  }
                }
              }

              if (
                action.kind === "retry" &&
                outcomes.get(scope) === "fallback" &&
                owners.some((o) => o.mounted)
              ) {
                outcomes.delete(scope);
                const retry =
                  ui.container.querySelector<HTMLButtonElement>("button");
                retry?.click();
              }

              const nextView = view();

              ui.rerender(nextView);
            });

            await flush();

            owners.forEach((owner, i) => {
              const region = screen.getByTestId(`owner-${i}`);
              const outcome = outcomes.get(scope);
              const resolvedState =
                owner.ref < 2 ? "rendered" : "ordinary-link";
              const mountedState =
                outcome === "rendered" ? resolvedState : (outcome ?? "loading");
              const state = owner.mounted ? mountedState : "unresolved";
              const expected =
                state === "rendered" ? `scope-${scope}-ref-${owner.ref}` : null;

              const previewTitles = region.querySelectorAll(
                '[data-testid="statechart-preview"] > span:first-child'
              );
              const titleNodes = Array.from(previewTitles);
              const names = titleNodes.map((node) => node.textContent);
              const expectedNames = expected ? [expected] : [];
              const links = region.querySelectorAll("a");
              const expectedLinkCount = owner.mounted ? 1 : 0;

              expect(names).toEqual(expectedNames);
              expect(links).toHaveLength(expectedLinkCount);
            });
          }
        } finally {
          ui.unmount();
          queryClient.clear();
          vi.useRealTimers();
        }
      },
      { testCases: 100 }
    ),
  30_000
);

it("supports canvas zoom gestures through the chat renderer", async () => {
  const chartArtifact = artifact();
  const response = { status: "ok", data: [chartArtifact] };

  list.mockResolvedValue(response);

  const reference = markdown(0);

  render(<MarkdownContent text={reference} />);

  const diagram = await screen.findByTestId("native-statechart-svg");
  const canvas = screen.getByLabelText("Scrollable statechart canvas");
  const widthAttribute = diagram.getAttribute("width");
  const width = Number(widthAttribute);

  fireEvent.wheel(canvas, {
    ctrlKey: true,
    deltaY: -100,
    clientX: 100,
    clientY: 100,
  });

  const zoomedWidthAttribute = diagram.getAttribute("width");
  const zoomedWidth = Number(zoomedWidthAttribute);

  expect(zoomedWidth).toBeGreaterThan(width);

  const zoomPercentage = screen.getByText("122%");

  expect(zoomPercentage).toBeInTheDocument();

  const zoomed = diagram.getAttribute("width");

  fireEvent.wheel(canvas, { deltaY: 100 });

  const widthAfterScroll = diagram.getAttribute("width");

  expect(widthAfterScroll).toBe(zoomed);

  const resetButton = screen.getByRole("button", { name: "Reset zoom" });

  fireEvent.click(resetButton);

  const resetWidthAttribute = diagram.getAttribute("width");
  const resetWidth = Number(resetWidthAttribute);

  expect(resetWidth).toBe(width);
});
