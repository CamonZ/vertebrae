/**
 * JSON Schema (draft 2020-12) for flow specs, generated from the registries
 * so authoring tools and agents see exactly the registered part kinds, their
 * props, verbs and the attachment kinds. Cross-references (rails to ports,
 * steps to parts and verbs) are checked by `validateFlowSpec`, not here.
 */
import { ATTACHMENT_COMMON_FIELDS } from "./attachments";
import { fieldsJsonSchema, type JsonSchema } from "./fields";
import type { FlowRegistry } from "./registry";
import {
  CHANGE_MARKS,
  FLOW_SPEC_VERSION,
  TOKEN_KINDS,
  WIRE_CHANGE_MARKS,
} from "./spec";

const id = { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]*$" };
const endpoint = {
  type: "string",
  pattern: "^.+\\.[^.]+$",
  description: "partId.port",
};
const ref = (name: string) => ({ $ref: `#/$defs/${name}` });

export function flowSpecJsonSchema(registry: FlowRegistry): JsonSchema {
  const partKinds = registry.parts.kinds();
  const attachmentKinds = registry.attachments.kinds();
  const commonAttachment = Object.fromEntries(
    Object.entries(
      fieldsJsonSchema(ATTACHMENT_COMMON_FIELDS).properties as Record<
        string,
        JsonSchema
      >
    ).filter(([k]) => k !== "kind")
  );
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "vertebrae:flow-spec",
    title: "Vertebrae flow spec",
    type: "object",
    required: ["version", "parts"],
    additionalProperties: false,
    properties: {
      version: { const: FLOW_SPEC_VERSION },
      title: { type: "string" },
      parts: { type: "array", minItems: 1, items: ref("part") },
      rails: { type: "array", items: ref("rail") },
      cards: { type: "array", items: ref("card") },
      story: { type: "array", items: ref("beat") },
      attachments: ref("attachments"),
    },
    $defs: {
      attachments: { type: "array", items: ref("attachment") },
      attachment: {
        type: "object",
        required: ["kind"],
        properties: { kind: { enum: attachmentKinds } },
        allOf: attachmentKinds.map((k) => {
          const def = registry.attachments.get(k)!;
          return {
            if: { properties: { kind: { const: k } } },
            then: fieldsJsonSchema(def.fields, {
              kind: { const: k },
              ...commonAttachment,
            }),
          };
        }),
      },
      position: {
        type: "object",
        required: ["x", "y"],
        additionalProperties: false,
        properties: { x: { type: "number" }, y: { type: "number" } },
      },
      part: {
        type: "object",
        required: ["id", "kind"],
        properties: {
          id,
          kind: { enum: partKinds },
          label: { type: "string" },
          job: { type: "string" },
          props: { type: "object" },
          change: { enum: CHANGE_MARKS },
          changeNote: { type: "string" },
          before: ref("override"),
          after: ref("override"),
          position: ref("position"),
          scale: { type: "number", minimum: 0.1, maximum: 4 },
          attachments: ref("attachments"),
          drill: {
            oneOf: [
              {
                type: "object",
                required: ["spec"],
                additionalProperties: false,
                properties: { spec: { $ref: "#" } },
              },
              {
                type: "object",
                required: ["artifact"],
                additionalProperties: false,
                properties: { artifact: { type: "string", format: "uuid" } },
              },
            ],
          },
        },
        additionalProperties: false,
        allOf: partKinds.map((k) => {
          const def = registry.parts.get(k)!;
          const props = fieldsJsonSchema(def.props ?? {});
          // Overrides are partial updates over the base props.
          const update = fieldsJsonSchema(def.props ?? {}, {}, true);
          return {
            if: { properties: { kind: { const: k } } },
            then: {
              description: `${k} · ${def.job}; ports: ${Object.keys(def.ports).join(", ")}; verbs: ${Object.keys(def.verbs).join(", ")}`,
              properties: {
                props,
                before: { properties: { props: update } },
                after: { properties: { props: update } },
              },
            },
          };
        }),
      },
      override: {
        type: "object",
        additionalProperties: false,
        properties: {
          props: { type: "object" },
          changeNote: { type: "string" },
        },
      },
      rail: {
        type: "object",
        required: ["id", "from", "to"],
        additionalProperties: false,
        properties: {
          id,
          from: endpoint,
          to: endpoint,
          label: { type: "string" },
          conditional: { type: "boolean" },
          change: { enum: WIRE_CHANGE_MARKS },
          attachments: ref("attachments"),
        },
      },
      card: {
        type: "object",
        required: ["id", "token"],
        additionalProperties: false,
        properties: {
          id,
          token: { enum: TOKEN_KINDS },
          label: { type: "string" },
          origin: { type: "string" },
          payload: {
            type: "object",
            required: ["type", "value"],
            additionalProperties: false,
            properties: {
              type: { type: "string" },
              value: { type: ["string", "number", "boolean", "null"] },
              eventTime: { type: ["number", "string"] },
              fields: {
                type: "object",
                additionalProperties: {
                  type: ["string", "number", "boolean", "null"],
                },
              },
            },
          },
          attachments: ref("attachments"),
        },
      },
      beat: {
        type: "object",
        additionalProperties: false,
        properties: {
          id,
          caption: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                additionalProperties: false,
                properties: {
                  before: { type: "string" },
                  after: { type: "string" },
                },
              },
            ],
          },
          steps: { type: "array", items: ref("step") },
          hold: { type: "number", minimum: 0 },
          attachments: ref("attachments"),
        },
      },
      step: {
        type: "object",
        required: ["verb", "part"],
        additionalProperties: false,
        properties: {
          verb: {
            enum: [
              ...new Set(
                partKinds.flatMap((k) =>
                  Object.keys(registry.parts.get(k)!.verbs)
                )
              ),
            ].sort(),
          },
          part: { type: "string" },
          card: { type: "string" },
          via: { type: "string" },
          with: { type: "boolean" },
          delay: { type: "number", minimum: 0 },
          args: { type: "object" },
          checkpoint: { type: "string" },
        },
      },
    },
  };
}
