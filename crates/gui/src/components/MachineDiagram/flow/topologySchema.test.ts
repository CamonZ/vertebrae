import Ajv2020 from "ajv/dist/2020";
import { expect, it } from "vitest";
import { createFlowRegistry } from "./defaults";
import { flowSpecJsonSchema } from "./jsonSchema";
import { decisionPort } from "./parts/topology";

// Execute the published draft-2020-12 schema with an independent validator,
// including inherited override modes; do not emulate JSON Schema in a test.
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(
  flowSpecJsonSchema(createFlowRegistry())
);

it("restricts legacy port-change keys while allowing instance-resolved topology ports", () => {
  for (const kind of [
    "route step",
    "inference step",
    "execute step",
    "human gate",
    "wait children",
    "structured step",
    "run end",
  ]) {
    for (const topology of [undefined, false, true]) {
      const part = {
        id: "p",
        kind,
        ...(topology === undefined ? {} : { props: { topology } }),
      };
      expect(
        validate({
          version: 1,
          parts: [{ ...part, portChanges: { in: "changed" } }],
        }),
        JSON.stringify(validate.errors)
      ).toBe(true);
      expect(
        validate({
          version: 1,
          parts: [{ ...part, portChanges: { unknown_port: "changed" } }],
        }),
        `${kind}/${topology}`
      ).toBe(topology === true);
    }
  }
  expect(
    validate({
      version: 1,
      parts: [
        {
          id: "p",
          kind: "route step",
          props: { topology: true, decisions: ["a real rule"] },
          portChanges: {
            [decisionPort("a real rule")]: "changed",
            default: "added",
          },
        },
      ],
    })
  ).toBe(true);
});

it("uses inherited and explicit arrangement modes for port-name constraints", () => {
  for (const base of [undefined, false, true])
    for (const override of [undefined, false, true]) {
      const props = base === undefined ? {} : { topology: base };
      const update =
        override === undefined ? {} : { props: { topology: override } };
      const dynamic = override ?? base ?? false;
      const shorthand = {
        id: "p",
        kind: "route step",
        change: "changed",
        props,
        after: update,
        portChanges: { unknown_port: "changed" },
      };
      expect(
        validate({ version: 1, parts: [shorthand] }),
        `after ${base}/${override}`
      ).toBe(dynamic);
      const named = {
        id: "p",
        kind: "route step",
        props,
        arrangement: {
          second: { ...update, portChanges: { unknown_port: "changed" } },
        },
      };
      expect(
        validate({
          version: 1,
          arrangements: ["first", "second"],
          parts: [named],
        }),
        `named ${base}/${override}`
      ).toBe(dynamic);
    }
});

it("uses a valid schema that permits no change keys on portless parts", () => {
  for (const portChanges of [{}, { nonexistent: "changed" }]) {
    expect(
      validate({ version: 1, parts: [{ id: "p", kind: "trace", portChanges }] })
    ).toBe(Object.keys(portChanges).length === 0);
  }
});
