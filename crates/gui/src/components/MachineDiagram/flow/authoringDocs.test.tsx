import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FlowSpecView } from "../../shared/FlowSpecView";
import { createFlowRegistry } from "./defaults";
import { flowSpecJsonSchema } from "./jsonSchema";
import { compileFlowLaidOut } from "./layout";
import { parseFlowSpec } from "./parse";

const docs = resolve("../../docs/agent-context");
const registry = createFlowRegistry();
const schema = flowSpecJsonSchema(registry);
const defs = schema.$defs as Record<
  string,
  {
    properties: Record<string, { enum: string[] }>;
  }
>;

function readDocs(folder: string): string {
  return readdirSync(resolve(docs, folder))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => readFileSync(resolve(docs, folder, name), "utf8"))
    .join("\n");
}

const reference = [
  readDocs("machine-diagrams/reference/parts"),
  readDocs("machine-diagrams/reference/attachments"),
].join("\n");
const recipes = readDocs("machine-diagrams/recipes");
const blocks = [...recipes.matchAll(/^```flow\n([\s\S]*?)^```/gm)].map(
  (m) => m[1]
);

afterEach(cleanup);

describe("machine-diagram authoring docs", () => {
  it("covers every schema kind, per-kind verb and attachment", () => {
    const headings = (level: string) =>
      [...reference.matchAll(new RegExp(`^${level} (.+)$`, "gm"))]
        .map((match) => match[1])
        .sort();
    expect(headings("## Part:")).toEqual(
      [...defs.part.properties.kind.enum].sort()
    );
    expect(headings("## Attachment:")).toEqual(
      [...defs.attachment.properties.kind.enum].sort()
    );
    expect(headings("###")).toEqual(
      defs.part.properties.kind.enum
        .flatMap((kind) =>
          Object.keys(registry.parts.get(kind)!.verbs).map(
            (verb) => `${kind}.${verb}`
          )
        )
        .sort()
    );
    // An entry needs semantics, not a generated placeholder bearing its name.
    expect(reference).not.toMatch(/`[^`]+` on this [^.]+\./);
    for (const section of reference.split(/^#{2,3} .+\n/gm).slice(1)) {
      expect(section.trim().length).toBeGreaterThan(30);
    }
  });

  it("publishes system, merged-PR, Before/After and drill recipes", () => {
    expect(blocks).toHaveLength(4);
  });

  it.each(blocks.map((body, i) => [i + 1, body] as const))(
    "recipe %i validates, lays out and renders in the shared viewer",
    async (_index, source) => {
      expect(source.trim().split("\n").length).toBeLessThanOrEqual(240);
      const parsed = parseFlowSpec(source);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      const result = await compileFlowLaidOut(parsed.value);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      expect(result.flow.arrangements.length).toBeGreaterThan(0);
      for (const diagram of result.flow.arrangements) {
        expect(diagram.width).toBeGreaterThan(0);
        expect(diagram.height).toBeGreaterThan(0);
      }
      render(<FlowSpecView source={source} />);
      expect(
        await screen.findByRole("group", { name: /flow player/i })
      ).toBeInTheDocument();
      expect(screen.queryByTestId("flow-errors")).not.toBeInTheDocument();
    }
  );
});
