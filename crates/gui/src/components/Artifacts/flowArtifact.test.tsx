/**
 * Flow artifacts in the artifact preview and in chat embeds: a flow spec
 * attached with flow presentation metadata plays in both, in light and dark;
 * an invalid spec shows its compiler errors; any other metadata keeps the
 * existing dispatch.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { Artifact, ArtifactLinkMetadata } from "../../bindings";
import { queryClient } from "../../query/queryClient";
import { resetProjectScopedStores } from "../../stores/projectScopedStores";
import { MarkdownContent } from "../shared/MarkdownContent";
import { ArtifactPreviewBody } from "./ArtifactPreviewBody";
import { isFlowMetadata } from "./flowArtifact";

const list = vi.hoisted(() => vi.fn());
vi.mock("../../bindings", () => ({
  commands: { listArtifactPresentations: list },
}));
vi.mock("../shared/CodeSnippet", () => ({
  default: ({ source }: { source: string }) => <code>{source}</code>,
}));

const yamlSpec = `version: 1
parts:
  - { id: src, kind: source, position: { x: 0, y: 0 } }
  - { id: w, kind: worker, position: { x: 400, y: 0 } }
rails:
  - { id: jobs, from: src.out, to: w.in }
cards:
  - { id: job, token: request, label: J }
story:
  - caption: a job is sent
    steps:
      - { verb: send, part: src, card: job }
  - caption: the worker runs it
    steps:
      - { verb: stage, part: w, card: job, via: jobs }
      - { verb: finish, part: w, card: job }`;
const jsonSpec = JSON.stringify({
  version: 1,
  parts: [
    { id: "src", kind: "source", position: { x: 0, y: 0 } },
    { id: "w", kind: "worker", position: { x: 400, y: 0 } },
  ],
  rails: [{ id: "jobs", from: "src.out", to: "w.in" }],
  cards: [{ id: "job", token: "request", label: "J" }],
  story: [
    {
      caption: "a job is sent",
      steps: [{ verb: "send", part: "src", card: "job" }],
    },
  ],
});

const flowMetadata = (format = "yaml"): ArtifactLinkMetadata => ({
  version: 1,
  content_kind: "flow",
  format,
  origin: "chat",
  presentation: "rendered",
  extensions: { flow_format: "flow-v1" },
});
const id = "860cde1b-9093-42ff-a19d-7453f3b7891f";
const flowArtifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  id,
  project_id: "project-1",
  filename: "diagram.flow.yaml",
  body: yamlSpec,
  logical_name: null,
  metadata: flowMetadata(),
  created_at: null,
  updated_at: null,
  ...overrides,
});

const themes = ["dark", "light"] as const;
function withTheme(theme: (typeof themes)[number]) {
  document.documentElement.classList.toggle("light", theme === "light");
}

beforeEach(() => {
  list.mockReset();
  resetProjectScopedStores();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
  document.documentElement.classList.remove("light");
});

describe("flow artifacts in the artifact preview", () => {
  it.each(
    themes.flatMap((theme) => [
      [theme, "yaml", yamlSpec],
      [theme, "json", jsonSpec],
    ])
  )("plays a %s %s spec", (theme, format, body) => {
    withTheme(theme);
    render(
      <ArtifactPreviewBody
        artifact={flowArtifact({ body, metadata: flowMetadata(format) })}
      />
    );
    expect(screen.getByTestId("flow-player")).toBeInTheDocument();
    expect(screen.getByTestId("machine-diagram-viewport")).toBeInTheDocument();
    expect(
      [...document.querySelectorAll("[data-part-id]")].map((e) =>
        e.getAttribute("data-part-id")
      )
    ).toEqual(["src", "w"]);
    expect(screen.queryByTestId("artifact-json-preview")).toBeNull();
  });

  it.each([
    ["broken YAML", "version: 1\nparts: [\n", ""],
    [
      "an unknown part kind",
      yamlSpec.replace("kind: worker", "kind: nope"),
      "parts[1].kind",
    ],
  ])(
    "lists compiler errors for %s instead of a blank pane",
    (_, body, path) => {
      render(<ArtifactPreviewBody artifact={flowArtifact({ body })} />);
      const errors = screen.getByTestId("flow-errors");
      expect(errors).toHaveAttribute("role", "alert");
      expect(errors).toHaveTextContent(/Flow spec has \d+ errors?/);
      expect(errors.querySelector("li")).not.toBeNull();
      if (path)
        expect(
          [...errors.querySelectorAll("li")].some(
            (li) => li.getAttribute("data-path") === path
          )
        ).toBe(true);
      expect(screen.queryByTestId("flow-player")).toBeNull();
    }
  );
});

describe("flow artifacts linked from chat", () => {
  it.each(themes)("render the playable diagram inline in %s", async (theme) => {
    withTheme(theme);
    list.mockResolvedValue({ status: "ok", data: [flowArtifact()] });
    render(
      <MarkdownContent text={`See [the flow](vtb://artifact/${id}) **here**`} />
    );
    expect(await screen.findByTestId("flow-player")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("data-vtb-entity-id", id);
    expect(screen.getByText("here")).toBeInTheDocument();
  });

  it("shows an invalid linked spec's errors beside the link", async () => {
    list.mockResolvedValue({
      status: "ok",
      data: [flowArtifact({ body: "version: 1\nparts: [\n" })],
    });
    render(<MarkdownContent text={`[the flow](vtb://artifact/${id})`} />);
    expect(await screen.findByTestId("flow-errors")).toBeInTheDocument();
    expect(screen.getByRole("link")).toBeInTheDocument();
  });

  it("keeps a non-flow artifact as a plain link", async () => {
    list.mockResolvedValue({
      status: "ok",
      data: [
        flowArtifact({
          metadata: { ...flowMetadata(), presentation: "raw" },
        }),
      ],
    });
    render(<MarkdownContent text={`[the flow](vtb://artifact/${id})`} />);
    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("flow-preview")).toBeNull();
    expect(screen.getByRole("link")).toBeInTheDocument();
  });
});

const metadataGenerator = gs.record({
  version: gs.sampledFrom([0, 1, 2]),
  content_kind: gs.sampledFrom(["flow", "statechart", "document", "Flow"]),
  format: gs.sampledFrom(["yaml", "json", "markdown", "jsonl", "YAML"]),
  presentation: gs.sampledFrom(["rendered", "raw"]),
});

describe("flow metadata", () => {
  it("property: recognises exactly v1 rendered flow specs in JSON or YAML", () =>
    hegel.test((tc) => {
      const m = tc.draw(metadataGenerator);
      const metadata = {
        ...m,
        origin: "chat",
        extensions: {},
      } as ArtifactLinkMetadata;
      expect(isFlowMetadata(metadata)).toBe(
        m.version === 1 &&
          m.content_kind === "flow" &&
          (m.format === "yaml" || m.format === "json") &&
          m.presentation === "rendered"
      );
    }));

  it("property: the preview plays a flow exactly when the metadata is flow", () =>
    hegel.test(
      (tc) => {
        const m = tc.draw(metadataGenerator);
        const metadata = {
          ...m,
          origin: "chat",
          extensions: {},
        } as ArtifactLinkMetadata;
        const body = tc.draw(gs.sampledFrom([yamlSpec, jsonSpec]));
        const view = render(
          <ArtifactPreviewBody artifact={flowArtifact({ body, metadata })} />
        );
        try {
          expect(view.queryByTestId("flow-player") !== null).toBe(
            isFlowMetadata(metadata)
          );
        } finally {
          view.unmount();
        }
      },
      { testCases: 60 }
    ));
});
