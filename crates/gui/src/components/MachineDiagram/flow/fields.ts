/**
 * A small field-schema language for part props, verb arguments and
 * attachment bodies. Registries declare fields with it; the validator checks
 * spec values against it and `fieldsJsonSchema` turns it into JSON Schema
 * for authoring tools.
 */
import { join, notFound, type FlowSpecError } from "./errors";

interface FieldBase {
  readonly description?: string;
  readonly required?: boolean;
}

export type FieldSchema =
  | (FieldBase & {
      readonly type: "string";
      readonly enum?: readonly string[];
      readonly default?: string;
    })
  | (FieldBase & {
      readonly type: "number" | "integer";
      readonly min?: number;
      readonly max?: number;
      readonly default?: number;
    })
  | (FieldBase & { readonly type: "boolean"; readonly default?: boolean })
  | (FieldBase & {
      readonly type: "string[]";
      readonly default?: readonly string[];
    })
  | (FieldBase & {
      readonly type: "object";
      readonly fields: Fields;
    })
  /** Any JSON value (e.g. a payload to compare). */
  | (FieldBase & { readonly type: "json" });

export type Fields = Readonly<Record<string, FieldSchema>>;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Own-property lookup: spec names like "constructor" must not resolve through the prototype. */
export function own<T>(
  obj: Readonly<Record<string, T>>,
  key: string
): T | undefined {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

const describe = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;

/** Check one value against its field schema, appending errors. */
export function checkField(
  value: unknown,
  f: FieldSchema,
  path: string,
  errors: FlowSpecError[]
): void {
  switch (f.type) {
    case "string":
      if (typeof value !== "string") {
        errors.push({
          path,
          message: `expected a string, got ${describe(value)}`,
        });
      } else if (f.enum && !f.enum.includes(value)) {
        errors.push({ path, ...notFound("value", value, f.enum, "allowed") });
      }
      return;
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push({
          path,
          message: `expected a number, got ${describe(value)}`,
        });
      } else if (f.type === "integer" && !Number.isInteger(value)) {
        errors.push({ path, message: `expected an integer, got ${value}` });
      } else if (f.min !== undefined && value < f.min) {
        errors.push({ path, message: `must be ≥ ${f.min}, got ${value}` });
      } else if (f.max !== undefined && value > f.max) {
        errors.push({ path, message: `must be ≤ ${f.max}, got ${value}` });
      }
      return;
    case "boolean":
      if (typeof value !== "boolean")
        errors.push({
          path,
          message: `expected a boolean, got ${describe(value)}`,
        });
      return;
    case "string[]":
      if (!Array.isArray(value) || value.some((x) => typeof x !== "string"))
        errors.push({ path, message: "expected a list of strings" });
      return;
    case "object":
      checkFields(value, f.fields, path, errors);
      return;
    case "json":
      return;
  }
}

/**
 * Check an object against a field set: required fields present, every
 * present field valid, and no unknown fields (named with the allowed ones).
 * `partial` checks an update: present fields only, nothing required.
 */
export function checkFields(
  value: unknown,
  fields: Fields,
  path: string,
  errors: FlowSpecError[],
  partial = false
): void {
  if (value === undefined) value = {};
  if (!isRecord(value)) {
    errors.push({
      path,
      message: `expected an object, got ${describe(value)}`,
    });
    return;
  }
  for (const [name, f] of Object.entries(fields)) {
    if (value[name] === undefined) {
      if (f.required && !partial)
        errors.push({ path: join(path, name), message: "is required" });
      continue;
    }
    checkField(value[name], f, join(path, name), errors);
  }
  for (const name of Object.keys(value)) {
    if (own(fields, name)) continue;
    errors.push({
      path: join(path, name),
      ...notFound("unknown field", name, Object.keys(fields), "allowed"),
    });
  }
}

/** Field values with defaults filled in (input assumed valid). */
export function withDefaults(
  value: Readonly<Record<string, unknown>> | undefined,
  fields: Fields
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(value ?? {}) };
  for (const [name, f] of Object.entries(fields)) {
    if (out[name] === undefined && "default" in f && f.default !== undefined)
      out[name] = f.default;
  }
  return out;
}

export type JsonSchema = { readonly [key: string]: unknown };

export function fieldJsonSchema(f: FieldSchema): JsonSchema {
  const d = f.description ? { description: f.description } : {};
  switch (f.type) {
    case "string":
      return { type: "string", ...(f.enum ? { enum: f.enum } : {}), ...d };
    case "number":
    case "integer":
      return {
        type: f.type,
        ...(f.min !== undefined ? { minimum: f.min } : {}),
        ...(f.max !== undefined ? { maximum: f.max } : {}),
        ...d,
      };
    case "boolean":
      return { type: "boolean", ...d };
    case "string[]":
      return { type: "array", items: { type: "string" }, ...d };
    case "object":
      return { ...fieldsJsonSchema(f.fields), ...d };
    case "json":
      return { ...d };
  }
}

export function fieldsJsonSchema(
  fields: Fields,
  extra: Readonly<Record<string, JsonSchema>> = {},
  partial = false
): JsonSchema {
  const required = Object.entries(fields)
    .filter(([, f]) => f.required && !partial)
    .map(([n]) => n);
  return {
    type: "object",
    properties: {
      ...extra,
      ...Object.fromEntries(
        Object.entries(fields).map(([n, f]) => [n, fieldJsonSchema(f)])
      ),
    },
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
