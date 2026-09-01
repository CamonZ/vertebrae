import { isMermaidRenderResultMessage, mermaidRenderRequest } from "./protocol";

export const MERMAID_RENDER_TIMEOUT_MS = 10_000;

type PendingRequest = {
  requestId: string; source: string; elementId: string;
  resolve: (svg: string) => void; reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>; settled: boolean;
};

let iframe: HTMLIFrameElement | undefined;
let frameReady = false;
let frameLoading = false;
let active: PendingRequest | undefined;
const queue: PendingRequest[] = [];

function dispatchNext(): void {
  if (!frameReady || active || !queue.length || !iframe) return;
  active = queue.shift();
  if (!active) return;
  const request = active;
  iframe.contentWindow?.postMessage(mermaidRenderRequest({ requestId: request.requestId, source: request.source, elementId: request.elementId }), "*");
}

function ensureRenderer(): void {
  if (iframe || frameLoading) return;
  frameLoading = true;
  iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts"); iframe.setAttribute("aria-hidden", "true"); iframe.title = "Mermaid renderer";
  Object.assign(iframe.style, { position: "fixed", left: "-2000px", top: "-2000px", width: "1024px", height: "768px", border: "0", opacity: "0", pointerEvents: "none" });
  iframe.addEventListener("load", () => { frameReady = true; frameLoading = false; dispatchNext(); });
  iframe.addEventListener("error", () => { frameReady = false; frameLoading = false; const error = new Error("Mermaid renderer failed to load."); while (queue.length) queue.shift()!.reject(error); active?.reject(error); active = undefined; });
  iframe.src = new URL("/mermaid-renderer.html", window.location.href).href;
  document.body.appendChild(iframe);
}

function onMessage(event: MessageEvent<unknown>): void {
  if (!iframe || event.source !== iframe.contentWindow || !isMermaidRenderResultMessage(event.data)) return;
  if (!active || event.data.requestId !== active.requestId) return;
  const request = active; active = undefined;
  if (request.timeout !== undefined) clearTimeout(request.timeout);
  if (!request.settled) {
    request.settled = true;
    if (event.data.status === "rendered") {
      request.resolve(event.data.svg);
    } else {
      request.reject(new Error(event.data.message));
    }
  }
  dispatchNext();
}

window.addEventListener("message", onMessage);

export function requestMermaidSvg(source: string, elementId: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const request: PendingRequest = { requestId: `${elementId}-${Date.now()}-${Math.random().toString(36).slice(2)}`, source, elementId, resolve, reject, settled: false };
    const abort = () => { if (request.settled) return; request.settled = true; const index = queue.indexOf(request); if (index >= 0) queue.splice(index, 1); if (request.timeout !== undefined) clearTimeout(request.timeout); reject(new Error("Mermaid rendering was cancelled.")); };
    if (signal?.aborted) return abort();
    request.timeout = setTimeout(() => {
      if (request.settled) return;
      request.settled = true;
      const index = queue.indexOf(request);
      if (index >= 0) queue.splice(index, 1);
      if (request.timeout !== undefined) clearTimeout(request.timeout);
      reject(new Error("Mermaid rendering timed out after 10 seconds."));
    }, MERMAID_RENDER_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    queue.push(request); ensureRenderer(); dispatchNext();
  });
}

// Kept private to production behavior; tests use it to isolate the singleton.
export function resetMermaidRendererForTests(): void {
  iframe?.remove();
  iframe = undefined;
  frameReady = false;
  frameLoading = false;
  active = undefined;
  queue.length = 0;
}
