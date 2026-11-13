/**
 * Built-in attachment kinds. Attachments are evidence and explanation hung
 * on parts, rails, cards and beats; rendering them is the evidence-panels
 * ticket (vtb://ticket/78b3cd9a-521b-474f-8569-c6e4dab3d2c7). Every
 * attachment also carries `status` (verified | inferred) and `source`
 * (scenario | trace), checked by the validator for all kinds.
 */
import type { Fields } from "./fields";
import type { AttachmentKindDef, AttachmentRegistry } from "./registry";

/** Fields every attachment may carry, whatever its kind. */
export const ATTACHMENT_COMMON_FIELDS: Fields = {
  kind: { type: "string", required: true },
  id: { type: "string" },
  title: { type: "string" },
  status: {
    type: "string",
    enum: ["verified", "inferred"],
    default: "inferred",
    description: "verified against code or a run, or the author's inference",
  },
  source: {
    type: "string",
    enum: ["scenario", "trace"],
    default: "scenario",
    description: "illustrative scenario or a recorded trace",
  },
};

const lineRange: NonNullable<AttachmentKindDef["check"]> = (body, path) =>
  typeof body.line === "number" &&
  typeof body.endLine === "number" &&
  body.endLine < body.line
    ? [{ path: `${path}.endLine`, message: "must be ≥ line" }]
    : [];

export const BUILTIN_ATTACHMENTS: readonly AttachmentKindDef[] = [
  {
    kind: "note",
    description: "a short explanation",
    fields: { text: { type: "string", required: true } },
  },
  {
    kind: "ref",
    description:
      "a file:line reference (opens the file at those lines, or its diff when it changed)",
    fields: {
      path: { type: "string", required: true },
      line: { type: "integer", min: 1 },
      endLine: { type: "integer", min: 1 },
      symbol: { type: "string" },
      claim: { type: "string", description: "what the reference shows" },
    },
    check: lineRange,
  },
  {
    kind: "diff",
    description:
      "a git diff: an inline patch, or base/head revisions opened as a diff",
    fields: {
      path: { type: "string" },
      patch: { type: "string", description: "unified diff text" },
      line: { type: "integer", min: 1 },
      endLine: { type: "integer", min: 1 },
      side: { type: "string", enum: ["old", "new"], default: "new" },
      base: { type: "string" },
      head: { type: "string" },
    },
    check: (body, path) => [
      ...lineRange(body, path),
      ...(body.patch === undefined && body.base === undefined
        ? [{ path, message: "a diff needs a patch or a base/head range" }]
        : []),
    ],
  },
  {
    kind: "formula",
    description: "a formula and the value it gives",
    fields: {
      unit: { type: "string" },
      expression: { type: "string", required: true },
      result: { type: "json" },
    },
  },
  {
    kind: "payload comparison",
    description: "expected vs actual payload",
    fields: {
      expected: { type: "json", required: true },
      actual: { type: "json", required: true },
      label: { type: "string" },
    },
  },
  {
    kind: "ui crop",
    description: "a cropped screenshot region",
    fields: {
      image: {
        type: "string",
        required: true,
        description: "artifact id or image URL",
      },
      rect: {
        type: "object",
        fields: {
          x: { type: "number", required: true },
          y: { type: "number", required: true },
          w: { type: "number", required: true, min: 0 },
          h: { type: "number", required: true, min: 0 },
        },
      },
    },
  },
  {
    kind: "timing",
    description: "a measured or illustrative duration",
    fields: {
      label: { type: "string", required: true },
      value: { type: "number", required: true, min: 0 },
      unit: { type: "string", enum: ["us", "ms", "s"], default: "ms" },
    },
  },
  {
    kind: "schema diff",
    description: "a schema or config before and after",
    fields: {
      before: { type: "string" },
      after: { type: "string" },
      format: {
        type: "string",
        enum: ["json", "yaml", "toml", "sql", "text"],
        default: "text",
      },
    },
    check: (body, path) =>
      body.before === undefined && body.after === undefined
        ? [{ path, message: "a schema diff needs before and/or after" }]
        : [],
  },
  {
    kind: "test summary",
    description: "test results and impacted areas",
    fields: {
      suite: { type: "string" },
      passed: { type: "integer", required: true, min: 0 },
      failed: { type: "integer", required: true, min: 0 },
      skipped: { type: "integer", min: 0 },
      impacted: { type: "string[]" },
    },
  },
];

export function registerBuiltinAttachments(r: AttachmentRegistry): void {
  for (const def of BUILTIN_ATTACHMENTS) r.register(def);
}
