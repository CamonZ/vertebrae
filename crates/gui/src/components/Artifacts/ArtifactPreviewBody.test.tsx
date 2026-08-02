import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Artifact } from "../../bindings";
import { ArtifactPreviewBody } from "./ArtifactPreviewBody";

const artifact = (overrides: Partial<Artifact> = {}): Artifact => ({
  id: "artifact-1",
  project_id: "project-1",
  filename: "artifact.txt",
  body: "body",
  logical_name: null,
  metadata: {
    version: 1,
    content_kind: "document",
    format: "markdown",
    origin: "test",
    presentation: "rendered",
    extensions: {},
  },
  created_at: null,
  updated_at: null,
  ...overrides,
});

const conversationLine = (type: string, data: Record<string, unknown>) =>
  JSON.stringify({
    version: 1,
    event_id: `event-${type}`,
    stream_id: "stream-1",
    timestamp: "2026-08-02T00:00:00Z",
    type,
    data,
  });

describe("ArtifactPreviewBody", () => {
  it("uses the shared Markdown renderer when metadata declares markdown", () => {
    render(
      <ArtifactPreviewBody
        artifact={artifact({ body: "# Heading\n\n**bold**" })}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Heading" })
    ).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
  });

  it("pretty-prints declared JSON deterministically", () => {
    render(
      <ArtifactPreviewBody
        artifact={artifact({
          body: '{"z":1,"nested":{"a":true}}',
          metadata: { ...artifact().metadata!, format: "json" },
        })}
      />
    );

    expect(screen.getByTestId("artifact-json-preview").textContent).toBe(
      '{\n  "z": 1,\n  "nested": {\n    "a": true\n  }\n}'
    );
  });

  it("preserves invalid JSON as selectable raw content", () => {
    render(
      <ArtifactPreviewBody
        artifact={artifact({
          body: "{not json}",
          metadata: { ...artifact().metadata!, format: "json" },
        })}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("not valid JSON");
    expect(screen.getByTestId("artifact-raw-body")).toHaveTextContent(
      "{not json}"
    );
  });

  it("renders normalized conversation JSONL without active-chat controls", () => {
    render(
      <ArtifactPreviewBody
        artifact={artifact({
          body: [
            conversationLine("turn_input", {
              provenance: "human",
              content: "Please summarize",
            }),
            conversationLine("text", { text: "Here is the summary." }),
          ].join("\n"),
          metadata: {
            ...artifact().metadata!,
            content_kind: "conversation",
            format: "jsonl",
            presentation: "raw",
          },
        })}
      />
    );

    expect(
      screen.getByTestId("artifact-conversation-preview")
    ).toBeInTheDocument();
    expect(screen.getByText("Please summarize")).toBeInTheDocument();
    expect(screen.getByText("Here is the summary.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /send/i })
    ).not.toBeInTheDocument();
  });

  it("falls back to raw content when one JSONL line is malformed", () => {
    render(
      <ArtifactPreviewBody
        artifact={artifact({
          body: `${conversationLine("text", { text: "valid" })}\nnot json`,
          metadata: {
            ...artifact().metadata!,
            content_kind: "conversation",
            format: "jsonl",
            presentation: "raw",
          },
        })}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("malformed");
    expect(screen.getByTestId("artifact-raw-body")).toHaveTextContent(
      "not json"
    );
  });

  it("uses raw content for metadata formats it does not support", () => {
    render(
      <ArtifactPreviewBody
        artifact={artifact({
          metadata: { ...artifact().metadata!, format: "yaml" },
        })}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unsupported artifact presentation"
    );
    expect(screen.getByTestId("artifact-raw-body")).toHaveTextContent("body");
  });
});
