import { isMermaidRenderResultMessage, mermaidRenderRequest } from "./protocol";

export const MERMAID_RENDER_TIMEOUT_MS = 10_000;

/**
 * Render Mermaid source to an SVG string in an isolated document.
 *
 * Mermaid's renderer needs a real `Document` (layout, SVG, d3). A Worker
 * cannot host that. A unique-origin iframe (`sandbox="allow-scripts"` without
 * `allow-same-origin`) is the browsing context we can create and destroy
 * without sharing the chat page's DOM. Timeout and abort tear that context
 * down.
 */
export function requestMermaidSvg(
  source: string,
  elementId: string,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement("iframe");
    const requestId = `${elementId}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    let settled = false;
    const timeout: { id?: ReturnType<typeof setTimeout> } = {};

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      iframe.removeEventListener("load", onLoad);
      iframe.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (timeout.id !== undefined) window.clearTimeout(timeout.id);
      iframe.remove();
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.contentWindow) return;
      if (!isMermaidRenderResultMessage(event.data)) return;
      const message = event.data;
      if (message.requestId !== requestId) return;

      if (message.status === "rendered") {
        settle(() => resolve(message.svg));
      } else {
        settle(() => reject(new Error(message.message)));
      }
    };

    const onLoad = () => {
      iframe.contentWindow?.postMessage(
        mermaidRenderRequest({ requestId, source, elementId }),
        "*"
      );
    };

    const onError = () => {
      settle(() => reject(new Error("Mermaid renderer failed to load.")));
    };

    const onAbort = () => {
      settle(() => reject(new Error("Mermaid rendering was cancelled.")));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("aria-hidden", "true");
    iframe.title = "Mermaid renderer";
    iframe.style.position = "fixed";
    iframe.style.left = "-2000px";
    iframe.style.top = "-2000px";
    iframe.style.width = "1024px";
    iframe.style.height = "768px";
    iframe.style.border = "0";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";
    iframe.addEventListener("load", onLoad);
    iframe.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    window.addEventListener("message", onMessage);
    timeout.id = setTimeout(() => {
      settle(() =>
        reject(new Error("Mermaid rendering timed out after 10 seconds."))
      );
    }, MERMAID_RENDER_TIMEOUT_MS);
    iframe.src = new URL("/mermaid-renderer.html", window.location.href).href;
    document.body.appendChild(iframe);
  });
}
