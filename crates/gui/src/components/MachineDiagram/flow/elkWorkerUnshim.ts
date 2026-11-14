/** Removes the placeholder `document` set by `elkWorkerShim` once ELK exists. */
import { PLACEHOLDER } from "./elkWorkerShim";

const scope = globalThis as { document?: unknown };
const placeholder = scope.document as Record<symbol, unknown> | undefined;
if (placeholder?.[PLACEHOLDER]) delete scope.document;
