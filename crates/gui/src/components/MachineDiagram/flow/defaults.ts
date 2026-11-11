import { registerBuiltinAttachments } from "./attachments";
import { registerStarterParts } from "./parts";
import {
  AttachmentRegistry,
  PartRegistry,
  type FlowRegistry,
} from "./registry";

export interface RegistryOptions {
  /** Register the starter parts and built-in attachments (default true). */
  builtins?: boolean;
}

/** A fresh registry; extend it with `parts.register` / `attachments.register`. */
export function createFlowRegistry(o: RegistryOptions = {}): FlowRegistry {
  const parts = new PartRegistry();
  const attachments = new AttachmentRegistry();
  if (o.builtins ?? true) {
    registerStarterParts(parts);
    registerBuiltinAttachments(attachments);
  }
  return { parts, attachments };
}
