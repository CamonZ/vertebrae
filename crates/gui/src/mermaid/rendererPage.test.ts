import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  MERMAID_RENDER_REQUEST,
  isMermaidRenderResultMessage,
  mermaidRenderRequest,
} from "./protocol";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  parse: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMock,
}));

describe("mermaid renderer page", () => {
  beforeAll(async () => {
    await import("./rendererPage");
  });

  beforeEach(() => {
    mermaidMock.render.mockReset();
    mermaidMock.parse.mockReset();
    mermaidMock.render.mockResolvedValue({ svg: "<svg>ok</svg>" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes mermaid once for the isolated renderer page", () => {
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
      })
    );
  });

  it("posts a rendered result to the parent without a separate parse call", async () => {
    const postMessage = vi.spyOn(window.parent, "postMessage");

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: mermaidRenderRequest({
          requestId: "req-1",
          source: "graph TD\n  A --> B",
          elementId: "diagram-1",
        }),
      })
    );

    await vi.waitFor(() => {
      expect(mermaidMock.render).toHaveBeenCalledWith(
        "diagram-1",
        "graph TD\n  A --> B"
      );
    });
    expect(mermaidMock.parse).not.toHaveBeenCalled();

    const result = postMessage.mock.calls
      .map(([data]) => data)
      .find(isMermaidRenderResultMessage);
    expect(result).toEqual({
      type: "vertebrae-mermaid-result",
      requestId: "req-1",
      status: "rendered",
      svg: "<svg>ok</svg>",
    });
  });

  it("posts an error result when mermaid render fails", async () => {
    const postMessage = vi.spyOn(window.parent, "postMessage");
    mermaidMock.render.mockRejectedValueOnce(new Error("Parse error"));

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: mermaidRenderRequest({
          requestId: "req-2",
          source: "graph TD\n  A -- B",
          elementId: "diagram-2",
        }),
      })
    );

    await vi.waitFor(() => {
      const result = postMessage.mock.calls
        .map(([data]) => data)
        .find(isMermaidRenderResultMessage);
      expect(result).toEqual({
        type: "vertebrae-mermaid-result",
        requestId: "req-2",
        status: "error",
        message: "Parse error",
      });
    });
  });

  it("ignores messages that are not mermaid render requests", async () => {
    const postMessage = vi.spyOn(window.parent, "postMessage");

    window.dispatchEvent(
      new MessageEvent("message", {
        source: window.parent,
        data: { type: MERMAID_RENDER_REQUEST, requestId: "req-3" },
      })
    );

    await Promise.resolve();
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(
      postMessage.mock.calls
        .map(([data]) => data)
        .find(isMermaidRenderResultMessage)
    ).toBeUndefined();
  });
});
