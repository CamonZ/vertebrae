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
const text = { type: "string", minLength: 1 };
const chips = { type: "array", minItems: 1, items: text };
/**
 * One value, or one per arrangement by name when they differ (`{ before,
 * after }` in the shorthand). The validator checks every arrangement is given.
 */
const perArrangement = (v: JsonSchema): JsonSchema => ({
  oneOf: [
    v,
    {
      type: "object",
      description: "one value per arrangement, by arrangement name",
      minProperties: 1,
      propertyNames: id,
      additionalProperties: v,
    },
  ],
});
/** Names from the spec's `arrangements` list. */
const arrangementList = (what: string): JsonSchema => ({
  type: "array",
  minItems: 1,
  uniqueItems: true,
  items: id,
  description: `named arrangements (or phases) ${what} (default: every one it can be in); needs a top-level arrangements or phases list`,
});

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
      arrangements: {
        type: "array",
        minItems: 1,
        description:
          "named arrangements of the machine (options A, B…), switched in place; absent: Before/After when anything is marked, otherwise one current arrangement",
        items: ref("arrangementDecl"),
      },
      phases: {
        type: "array",
        minItems: 1,
        description:
          "phases of a migration in order (today → … → target), instead of arrangements: the story moves through them, each started by a beat's phase, and each is marked against the phase before it",
        items: ref("arrangementDecl"),
      },
      baseline: {
        ...id,
        description:
          "the arrangement the others are marked against (default: the first)",
      },
      parts: { type: "array", minItems: 1, items: ref("part") },
      rails: { type: "array", items: ref("rail") },
      regions: { type: "array", items: ref("region") },
      cards: { type: "array", items: ref("card") },
      story: { type: "array", items: ref("beat") },
      band: ref("band"),
      attachments: ref("attachments"),
    },
    not: { required: ["arrangements", "phases"] },
    $defs: {
      arrangementDecl: {
        oneOf: [
          id,
          {
            type: "object",
            required: ["name"],
            additionalProperties: false,
            properties: { name: id, label: { type: "string" } },
          },
        ],
      },
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
          portChanges: {
            type: "object",
            description: "change marks on the part's ports, by port name",
            additionalProperties: { enum: CHANGE_MARKS },
          },
          stageChanges: {
            type: "object",
            description:
              "change marks on the part's stages, by stage name (kinds with stages)",
            additionalProperties: { enum: CHANGE_MARKS },
          },
          before: ref("override"),
          after: ref("override"),
          in: arrangementList("the part is in"),
          arrangement: {
            type: "object",
            description:
              "named arrangements only: overrides by arrangement name; a part whose override differs from the baseline's is marked changed",
            propertyNames: id,
            additionalProperties: ref("namedOverride"),
          },
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
                portChanges: {
                  propertyNames: { enum: Object.keys(def.ports) },
                },
                ...(def.stages ? {} : { stageChanges: false }),
                before: { properties: { props: update } },
                after: { properties: { props: update } },
                arrangement: {
                  additionalProperties: {
                    properties: {
                      props: update,
                      portChanges: {
                        propertyNames: { enum: Object.keys(def.ports) },
                      },
                      ...(def.stages ? {} : { stageChanges: false }),
                    },
                  },
                },
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
      namedOverride: {
        type: "object",
        additionalProperties: false,
        properties: {
          props: { type: "object" },
          changeNote: { type: "string" },
          portChanges: {
            type: "object",
            description:
              "change marks on the part's ports in this arrangement, by port name",
            additionalProperties: { enum: CHANGE_MARKS },
          },
          stageChanges: {
            type: "object",
            description:
              "change marks on the part's stages in this arrangement, by stage name",
            additionalProperties: { enum: CHANGE_MARKS },
          },
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
          in: arrangementList("the rail is in"),
          attachments: ref("attachments"),
        },
      },
      region: {
        type: "object",
        required: ["id", "parts"],
        additionalProperties: false,
        properties: {
          id,
          label: { type: "string" },
          parts: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string" },
          },
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
                description:
                  "one caption per arrangement, by name ({ before, after } in the shorthand); an arrangement without one continues the previous caption",
                propertyNames: id,
                additionalProperties: { type: "string" },
              },
            ],
          },
          phase: {
            ...id,
            description:
              "phased specs: the phase this beat starts, the next one in phases; later beats stay in it",
          },
          steps: { type: "array", items: ref("step") },
          hold: { type: "number", minimum: 0 },
          attachments: ref("attachments"),
        },
      },
      band: {
        type: "object",
        required: ["rows"],
        additionalProperties: false,
        description:
          "A strip under the diagram: one row per situation, lit during its story beats, and an optional marker counter.",
        properties: {
          heading: text,
          rows: { type: "array", minItems: 1, items: ref("bandRow") },
          meter: {
            type: "object",
            required: ["label", "marker"],
            additionalProperties: false,
            properties: {
              label: text,
              marker: {
                description:
                  "Marker kind(s) to count per arrangement, e.g. spawn, close, checkpoint, arrival",
                oneOf: [
                  text,
                  {
                    type: "array",
                    minItems: 1,
                    uniqueItems: true,
                    items: text,
                  },
                ],
              },
              footnote: text,
            },
          },
        },
      },
      bandRow: {
        type: "object",
        required: ["name", "chips", "beats"],
        additionalProperties: false,
        properties: {
          name: text,
          note: perArrangement(text),
          chips: perArrangement(chips),
          beats: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { ...id, description: "story beat id" },
          },
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
          change: {
            enum: CHANGE_MARKS,
            description:
              "Before/After shorthand: added runs only in After; removed only in Before; marked on its beat in After",
          },
          in: arrangementList("the step runs in"),
        },
      },
    },
  };
}
