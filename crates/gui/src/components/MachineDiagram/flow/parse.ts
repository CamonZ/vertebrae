/**
 * Read a flow spec from text: JSON, or YAML (a ```flow block or a file).
 * YAML is read with the JSON schema, so values keep their JSON types
 * (no implicit dates).
 */
import { JSON_SCHEMA, YAMLException, load } from "js-yaml";
import type { FlowSpecError } from "./errors";

export type ParseResult =
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly format: "json" | "yaml";
    }
  | { readonly ok: false; readonly errors: readonly FlowSpecError[] };

export function parseFlowSpec(text: string): ParseResult {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return { ok: true, value: JSON.parse(trimmed), format: "json" };
    } catch (e) {
      return {
        ok: false,
        errors: [
          { path: "", message: `invalid JSON: ${(e as Error).message}` },
        ],
      };
    }
  }
  try {
    return {
      ok: true,
      value: load(text, { schema: JSON_SCHEMA }),
      format: "yaml",
    };
  } catch (e) {
    const m = e instanceof YAMLException ? e.reason : (e as Error).message;
    const line =
      e instanceof YAMLException && e.mark ? ` at line ${e.mark.line + 1}` : "";
    return {
      ok: false,
      errors: [{ path: "", message: `invalid YAML${line}: ${m}` }],
    };
  }
}
