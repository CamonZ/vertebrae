import { describe, expect, it } from "vitest";
import {
  MERMAID_RENDER_REQUEST,
  MERMAID_RENDER_RESULT,
  isMermaidRenderRequest,
  isMermaidRenderResultMessage,
  mermaidRenderRequest,
  mermaidRenderResult,
} from "./protocol";

describe("mermaid protocol", () => {
  it("accepts well-formed render requests", () => {
    const request = mermaidRenderRequest({
      requestId: "req-1",
      source: "graph TD\n  A --> B",
      elementId: "diagram-1",
    });

    expect(request.type).toBe(MERMAID_RENDER_REQUEST);
    expect(isMermaidRenderRequest(request)).toBe(true);
  });

  it("rejects malformed render requests", () => {
    expect(isMermaidRenderRequest(null)).toBe(false);
    expect(isMermaidRenderRequest({ type: MERMAID_RENDER_REQUEST })).toBe(
      false
    );
    expect(
      isMermaidRenderRequest({
        type: MERMAID_RENDER_RESULT,
        requestId: "req-1",
        source: "graph TD",
        elementId: "diagram-1",
      })
    ).toBe(false);
  });

  it("accepts rendered and error results", () => {
    const rendered = mermaidRenderResult({
      requestId: "req-1",
      status: "rendered",
      svg: "<svg></svg>",
    });
    const failed = mermaidRenderResult({
      requestId: "req-1",
      status: "error",
      message: "Parse error",
    });

    expect(isMermaidRenderResultMessage(rendered)).toBe(true);
    expect(isMermaidRenderResultMessage(failed)).toBe(true);
  });

  it("rejects malformed results", () => {
    expect(isMermaidRenderResultMessage(undefined)).toBe(false);
    expect(
      isMermaidRenderResultMessage({
        type: MERMAID_RENDER_RESULT,
        requestId: "req-1",
        status: "rendered",
      })
    ).toBe(false);
    expect(
      isMermaidRenderResultMessage({
        type: MERMAID_RENDER_RESULT,
        requestId: "req-1",
        status: "error",
      })
    ).toBe(false);
  });
});
