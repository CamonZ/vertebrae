import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import type { FlowValidation } from "./validatorEntry";

// Kept in step with vite.flow-validator.config.ts, which imports vite and so
// cannot load under jsdom (esbuild rejects jsdom's TextEncoder).
const BUNDLE = "flow-validator.js";
const committed = readFileSync(resolve("../cli/assets", BUNDLE), "utf8");
const scratch = mkdtempSync(join(tmpdir(), "flow-validator-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Run the bundle the way vtb does: a bare global scope, no DOM, no Node. */
function validate(source: string): FlowValidation {
  const sandbox: { vtbValidateFlow?: (s: string) => string } = {};
  runInNewContext(committed, sandbox);

  return JSON.parse(sandbox.vtbValidateFlow!(source)) as FlowValidation;
}

describe("embedded flow validator bundle", () => {
  it("matches a fresh build (run `npm run build:flow-validator`)", () => {
    const vite = resolve("node_modules/vite/bin/vite.js");
    const args = ["build", "--config", "vite.flow-validator.config.ts"];
    const run = spawnSync(
      process.execPath,
      [vite, ...args, "--outDir", scratch, "--mode", "module-graph"],
      {
        encoding: "utf8",
        // Build as `npm run build:flow-validator` does, not in vitest's test mode.
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => k !== "NODE_ENV" && !k.startsWith("VITEST")
          )
        ),
      }
    );

    expect(run.status, run.stderr).toBe(0);

    const modules: string[] = JSON.parse(
      readFileSync(join(scratch, "modules.json"), "utf8")
    );
    expect(modules.length).toBeGreaterThan(0);
    expect(
      modules.filter(
        (id) =>
          /\.tsx(?:$|\?)/.test(id) ||
          /node_modules\/(?:react(?:-dom)?|scheduler)(?:\/|$)/.test(id) ||
          /MachineDiagram\/(?:parts\/draw|fixtures|geometry|flow\/(?:drawings|attachmentRenderers))\./.test(
            id
          )
      ),
      "validator must depend only on spec modules"
    ).toEqual([]);

    const fresh = readFileSync(join(scratch, BUNDLE), "utf8");
    expect(
      fresh === committed,
      "crates/cli/assets/flow-validator.js is stale"
    ).toBe(true);
  }, 60_000);

  it("runs without browser or Node globals", () => {
    expect(validate("version: 1\nparts: [{id: a, kind: source}]")).toEqual({
      ok: true,
      format: "yaml",
      errors: [],
    });
  });

  it("reports compile errors as formatFlowError lines", () => {
    const result = validate(
      [
        "version: 1",
        "parts: [{id: a, kind: source}, {id: b, kind: wroker}]",
        "rails: [{from: a.out, to: b.in}]",
      ].join("\n")
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe("parts[1].kind");
    expect(result.errors[0].line).toMatch(
      /^parts\[1\]\.kind: unknown part kind "wroker" \(did you mean "worker"\?\)/
    );
  });

  it("reports unparseable input at the document root", () => {
    const result = validate("parts: [a");

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ path: "" });
    expect(result.errors[0].line).toMatch(/^invalid YAML at line \d+:/);
  });
});
