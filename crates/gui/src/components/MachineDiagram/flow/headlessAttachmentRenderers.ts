/**
 * Stands in for `attachmentRenderers.tsx` in the standalone validator bundle
 * (vite.flow-validator.config.ts). Validation never renders evidence, and the
 * real renderers pull in the app's query client, stores and Tauri bindings.
 */
import type { AttachmentKindDef } from "./registry";

export const attachmentRenderers: Record<
  string,
  NonNullable<AttachmentKindDef["render"]>
> = {};
