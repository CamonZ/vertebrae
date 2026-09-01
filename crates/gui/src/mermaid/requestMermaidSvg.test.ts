import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { isMermaidRenderRequest, mermaidRenderResult } from "./protocol";
import {
  MERMAID_RENDER_TIMEOUT_MS,
  requestMermaidSvg,
  resetMermaidRendererForTests,
} from "./requestMermaidSvg";

function installMermaidRendererFrameMock(): () => void {
  const createElement = document.createElement.bind(document);
  const createElementSpy = vi
    .spyOn(document, "createElement")
    .mockImplementation((localName, options) => {
      const element = createElement(localName, options);
      if (localName.toLowerCase() !== "iframe") return element;

      const rendererWindow = {
        postMessage(message: unknown) {
          if (!isMermaidRenderRequest(message)) return;
          void Promise.resolve().then(() => {
            window.dispatchEvent(
              new MessageEvent("message", {
                source: rendererWindow,
                data: mermaidRenderResult({
                  requestId: message.requestId,
                  status: "rendered",
                  svg: `<svg id="${message.elementId}">${message.source}</svg>`,
                }),
              })
            );
          });
        },
      } as unknown as Window;
      Object.defineProperty(element, "contentWindow", {
        configurable: true,
        value: rendererWindow,
      });
      return element;
    });
  const appendChild = Node.prototype.appendChild;
  const appendChildSpy = vi
    .spyOn(Node.prototype, "appendChild")
    .mockImplementation(function (this: Node, node: Node) {
      const result = appendChild.call(this, node);
      if (
        node instanceof HTMLIFrameElement &&
        node.title === "Mermaid renderer"
      ) {
        queueMicrotask(() => fireEvent.load(node));
      }
      return result;
    });

  return () => {
    createElementSpy.mockRestore();
    appendChildSpy.mockRestore();
  };
}

describe("requestMermaidSvg", () => {
  let restoreFrameMock: (() => void) | undefined;

  afterEach(() => {
    resetMermaidRendererForTests();
    document
      .querySelectorAll('iframe[title="Mermaid renderer"]')
      .forEach((frame) => frame.remove());
    restoreFrameMock?.();
    restoreFrameMock = undefined;
    vi.useRealTimers();
  });

  it("renders through one persistent sandboxed mermaid-renderer frame", async () => {
    restoreFrameMock = installMermaidRendererFrameMock();

    const svgPromise = requestMermaidSvg("graph TD\n  A --> B", "diagram-1");
    const rendererFrame = document.querySelector(
      'iframe[title="Mermaid renderer"]'
    );
    expect(rendererFrame).not.toBeNull();
    expect(rendererFrame).toHaveAttribute(
      "sandbox",
      "allow-scripts allow-same-origin"
    );
    expect(rendererFrame).toHaveAttribute(
      "src",
      expect.stringContaining("mermaid-renderer.html")
    );

    await expect(svgPromise).resolves.toContain("graph TD");
    expect(document.querySelector('iframe[title="Mermaid renderer"]')).not.toBeNull();
    await expect(requestMermaidSvg("graph TD\n  B --> C", "diagram-2")).resolves.toContain("diagram-2");
    expect(document.querySelectorAll('iframe[title="Mermaid renderer"]')).toHaveLength(1);
  });

  it("rejects on abort and waits for the renderer to finish before teardown", async () => {
    restoreFrameMock = installMermaidRendererFrameMock();
    const controller = new AbortController();
    const pending = requestMermaidSvg(
      "graph TD\n  A --> B",
      "diagram-1",
      controller.signal
    );
    const cancelled = expect(pending).rejects.toThrow(
      "Mermaid rendering was cancelled."
    );

    expect(
      document.querySelector('iframe[title="Mermaid renderer"]')
    ).not.toBeNull();

    controller.abort();
    await cancelled;
    expect(document.querySelector('iframe[title="Mermaid renderer"]')).not.toBeNull();
  });

  it("rejects immediately when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      requestMermaidSvg("graph TD\n  A --> B", "diagram-1", controller.signal)
    ).rejects.toThrow("Mermaid rendering was cancelled.");
    expect(
      document.querySelector('iframe[title="Mermaid renderer"]')
    ).toBeNull();
  });

  it("times out without destroying an in-flight renderer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const createElement = document.createElement.bind(document);
    const createElementSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation((localName, options) => {
        const element = createElement(localName, options);
        if (localName.toLowerCase() === "iframe") {
          Object.defineProperty(element, "contentWindow", {
            configurable: true,
            value: { postMessage() {} },
          });
        }
        return element;
      });
    restoreFrameMock = () => createElementSpy.mockRestore();

    const pending = requestMermaidSvg("graph TD\n  A --> B", "diagram-1");
    const timedOut = expect(pending).rejects.toThrow(
      "Mermaid rendering timed out after 10 seconds."
    );
    expect(
      document.querySelector('iframe[title="Mermaid renderer"]')
    ).not.toBeNull();

    await vi.advanceTimersByTimeAsync(MERMAID_RENDER_TIMEOUT_MS);
    await timedOut;
    expect(
      document.querySelector('iframe[title="Mermaid renderer"]')
    ).not.toBeNull();
  });
});
