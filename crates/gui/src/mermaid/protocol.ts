export const MERMAID_RENDER_REQUEST = "vertebrae-mermaid-render";
export const MERMAID_RENDER_RESULT = "vertebrae-mermaid-result";

export type MermaidRenderRequest = {
  type: typeof MERMAID_RENDER_REQUEST;
  requestId: string;
  source: string;
  elementId: string;
};

export type MermaidRenderResultMessage =
  | {
      type: typeof MERMAID_RENDER_RESULT;
      requestId: string;
      status: "rendered";
      svg: string;
    }
  | {
      type: typeof MERMAID_RENDER_RESULT;
      requestId: string;
      status: "error";
      message: string;
    };

export function isMermaidRenderRequest(
  value: unknown
): value is MermaidRenderRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<MermaidRenderRequest>;
  return (
    request.type === MERMAID_RENDER_REQUEST &&
    typeof request.requestId === "string" &&
    typeof request.source === "string" &&
    typeof request.elementId === "string"
  );
}

export function isMermaidRenderResultMessage(
  value: unknown
): value is MermaidRenderResultMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<MermaidRenderResultMessage>;
  if (
    message.type !== MERMAID_RENDER_RESULT ||
    typeof message.requestId !== "string"
  ) {
    return false;
  }
  if (message.status === "rendered") return typeof message.svg === "string";
  return message.status === "error" && typeof message.message === "string";
}

export function mermaidRenderRequest(
  request: Omit<MermaidRenderRequest, "type">
): MermaidRenderRequest {
  return { type: MERMAID_RENDER_REQUEST, ...request };
}

export function mermaidRenderResult(
  result:
    | { requestId: string; status: "rendered"; svg: string }
    | { requestId: string; status: "error"; message: string }
): MermaidRenderResultMessage {
  return { type: MERMAID_RENDER_RESULT, ...result };
}
