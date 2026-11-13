/**
 * Entry point for the standalone flow-spec validator that `vtb flow validate`
 * embeds and runs in QuickJS. It runs the chat viewer's parse and compile
 * path (without ELK layout, which never adds spec errors) and returns every
 * diagnostic as a `formatFlowError` line.
 *
 * Built by `npm run build:flow-validator` into `crates/cli/assets/`; the
 * bundle is committed and `flowValidator.bundle.test.ts` fails when stale.
 */
import { compileFlow } from "./compile";
import { formatFlowError, type FlowSpecError } from "./errors";
import { parseFlowSpec } from "./parse";

export interface FlowValidation {
  readonly ok: boolean;
  readonly format?: "json" | "yaml";
  readonly errors: readonly (FlowSpecError & { readonly line: string })[];
}

export function validateFlowSource(source: string): FlowValidation {
  const parsed = parseFlowSpec(source);
  const errors = parsed.ok ? compiled(parsed.value) : parsed.errors;
  return {
    ok: errors.length === 0,
    ...(parsed.ok ? { format: parsed.format } : {}),
    errors: errors.map((e) => ({ ...e, line: formatFlowError(e) })),
  };
}

function compiled(value: unknown): readonly FlowSpecError[] {
  const result = compileFlow(value);
  return result.ok ? [] : result.errors;
}

/** JSON in, JSON out: the only surface the Rust host calls. */
export function validateFlowJson(source: string): string {
  return JSON.stringify(validateFlowSource(source));
}

(globalThis as { vtbValidateFlow?: unknown }).vtbValidateFlow =
  validateFlowJson;
