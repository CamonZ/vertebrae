import mermaid from "mermaid";

const RENDER_REQUEST = "vertebrae-mermaid-render";
const RENDER_RESULT = "vertebrae-mermaid-result";

interface MermaidRenderRequest {
  type: typeof RENDER_REQUEST;
  requestId: string;
  source: string;
  elementId: string;
}

function isMermaidRenderRequest(value: unknown): value is MermaidRenderRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<MermaidRenderRequest>;
  return (
    request.type === RENDER_REQUEST &&
    typeof request.requestId === "string" &&
    typeof request.source === "string" &&
    typeof request.elementId === "string"
  );
}

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  deterministicIds: true,
  deterministicIDSeed: "vertebrae-chat",
  theme: "dark",
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  htmlLabels: false,
  flowchart: { htmlLabels: false, useMaxWidth: true },
  sequence: { useMaxWidth: true },
});

async function render(request: MermaidRenderRequest): Promise<void> {
  try {
    // render() parses the definition itself. Avoiding a separate parse call
    // both halves the work and prevents a parser-only operation from running
    // before the isolated renderer can be torn down on timeout.
    const { svg } = await mermaid.render(request.elementId, request.source);
    window.parent.postMessage(
      {
        type: RENDER_RESULT,
        requestId: request.requestId,
        status: "rendered",
        svg,
      },
      "*"
    );
  } catch (error: unknown) {
    window.parent.postMessage(
      {
        type: RENDER_RESULT,
        requestId: request.requestId,
        status: "error",
        message:
          error instanceof Error ? error.message : "Unknown renderer error.",
      },
      "*"
    );
  }
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent) return;
  if (!isMermaidRenderRequest(event.data)) return;
  void render(event.data);
});
