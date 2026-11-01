import { beforeAll, expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import { readFile } from "node:fs/promises";
import { Language, Parser } from "web-tree-sitter";
import { analyzeActivity } from "./parser";
import type { ActivityAnalysis } from "./types";
let languages: Record<"javascript" | "bash" | "python", Language>;
beforeAll(async () => {
  await Parser.init({
    wasmBinary: await readFile("node_modules/web-tree-sitter/tree-sitter.wasm"),
  });
  const [javascript, bash, python] = await Promise.all(
    ["javascript", "bash", "python"].map(async (name) =>
      Language.load(
        new Uint8Array(
          await readFile(
            `node_modules/tree-sitter-wasms/out/tree-sitter-${name}.wasm`
          )
        )
      )
    )
  );
  languages = { javascript, bash, python };
});
const shell = (cmd: string) =>
  analyzeActivity({ name: "exec_command", input: { cmd } }, languages);
const js = (code: string) =>
  analyzeActivity({ name: "exec", input: { code } }, languages);
const labels = (r: ActivityAnalysis) =>
  [...new Set(r.operations.flatMap((o) => o.activities))].sort();
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const noise = gs.text({
  alphabet: "abc XYZ012/\\'\"`$(){}[];|&<>\n\t#",
  maxSize: 60,
});
const commands = [
  { source: "cargo test", activity: "checks" },
  { source: "git status", activity: "Git inspection" },
  { source: "cat src/a.rs", activity: "source inspection" },
  { source: "cat docs/testing.md", activity: "documentation" },
] as const;

test("generated command-like data cannot inject activities through quoting, comments or heredocs", () =>
  hegel.test((tc) => {
    const payload = `${tc.draw(noise)}\n${tc.draw(gs.sampledFrom(commands)).source}\n${tc.draw(noise)}`;
    const literal = JSON.stringify(payload);
    expect(
      labels(js(`const data = {cmd:${literal}}; const text = ${literal};`))
    ).toEqual([]);
    const comments = payload
      .split("\n")
      .map((line) => `# ${line}`)
      .join("\n");
    expect(labels(shell(`git status\n${comments}\n`))).toEqual([
      "Git inspection",
    ]);
    expect(labels(shell(`rg -- ${quote(payload)} src`))).toEqual([
      "source search",
    ]);
    let delimiter = "PAYLOAD_END";
    while (payload.split("\n").includes(delimiter)) delimiter += "_";
    const heredoc = shell(
      `cat > /tmp/generated.txt <<'${delimiter}'\n${payload}\n${delimiter}\n`
    );
    // Some valid quoted-heredoc payloads exceed this grammar's support (e.g.
    // a trailing backslash). Such input must fail open, never classify payloads.
    expect(labels(heredoc).every((label) => label === "file edits")).toBe(true);
    if (!labels(heredoc).length)
      expect(heredoc.operations.some((o) => o.unresolved)).toBe(true);
  }));

test("supported sequence composition preserves submitted operations, including repeats", () =>
  hegel.test((tc) => {
    const leaves = tc.draw(
      gs.arrays(gs.sampledFrom(commands), { minSize: 1, maxSize: 18 })
    );
    const row = shell(leaves.map((l) => l.source).join("; "));
    expect(row.operations.map((o) => o.source)).toEqual(
      leaves.map((l) => l.source)
    );
    expect(row.operations.map((o) => o.activities[0])).toEqual(
      leaves.map((l) => l.activity)
    );
    expect(row.operations.every((o) => !("status" in o))).toBe(true);
  }));

// The generator supplies the expected conditional edges independently of tree-sitter.
function conditionTree(
  tc: TestCase,
  depth = 0
): { source: string; leaves: { source: string; conditions: string[] }[] } {
  if (depth === 3 || tc.draw(gs.booleans())) {
    const leaf = tc.draw(gs.sampledFrom(commands));
    return {
      source: leaf.source,
      leaves: [{ source: leaf.source, conditions: [] }],
    };
  }
  const left = conditionTree(tc, depth + 1),
    right = conditionTree(tc, depth + 1);
  const operator = tc.draw(gs.sampledFrom(["&&", "||"]));
  const relation = operator === "&&" ? "on success" : "on failure";
  return {
    source: `( ${left.source} ) ${operator} ( ${right.source} )`,
    leaves: [
      ...left.leaves,
      ...right.leaves.map((l) => ({
        ...l,
        conditions: [...new Set([...l.conditions, relation])].sort(),
      })),
    ],
  };
}
test("generated conditional trees attach conditions only to the governed operations", () =>
  hegel.test((tc) => {
    const tree = conditionTree(tc);
    const row = shell(tree.source);
    expect(
      row.operations.map((o) => ({
        source: o.source,
        conditions: o.relationships
          .filter((r) => r === "on success" || r === "on failure")
          .sort(),
      }))
    ).toEqual(tree.leaves);
    expect(row.operations.every((o) => !("status" in o))).toBe(true);
  }));

test("generated pipelines remain stream filters and background requests remain unconfirmed", () =>
  hegel.test((tc) => {
    const first = tc.draw(gs.sampledFrom(commands));
    const filters = tc.draw(
      gs.arrays(gs.sampledFrom(["grep marker", "head -5", "sort", "wc -l"]), {
        minSize: 1,
        maxSize: 8,
      })
    );
    const pipeline = shell([first.source, ...filters].join(" | "));
    expect(labels(pipeline)).toEqual([first.activity]);
    expect(
      pipeline.operations.every((o) => o.relationships.includes("pipeline"))
    ).toBe(true);
    const second = tc.draw(gs.sampledFrom(commands));
    const background = shell(`${first.source} & ${second.source}`);
    expect(background.operations.map((o) => o.source)).toEqual([
      first.source,
      second.source,
    ]);
    expect(
      background.operations.every(
        (o) =>
          o.relationships.includes("background / parallel") && !("status" in o)
      )
    ).toBe(true);
  }));

test("nested wrappers preserve operation multiplicity and explicitly retain unresolved calls", () =>
  hegel.test((tc) => {
    const leaves = tc.draw(
      gs.arrays(gs.sampledFrom(commands), { minSize: 1, maxSize: 12 })
    );
    const parallel = tc.draw(gs.booleans());
    const calls = leaves.map(
      (l) => `tools.exec_command({cmd:${JSON.stringify(l.source)}})`
    );
    const source = parallel
      ? `await Promise.all([${calls.join(",")}, tools.exec_command(dynamic)]);`
      : `${calls.map((c) => `await ${c};`).join("\n")} await tools.exec_command(dynamic);`;
    const row = js(source);
    expect(
      row.operations.filter((o) => o.activities[0]).map((o) => o.source)
    ).toEqual(leaves.map((l) => l.source));
    expect(row.operations.some((o) => o.unresolved)).toBe(true);
    expect(
      row.operations.every((o) =>
        o.relationships.includes("nested invocation (requested)")
      )
    ).toBe(true);
    expect(
      row.operations.some((o) => o.relationships.includes("parallel requests"))
    ).toBe(parallel);
    expect(row.operations.every((o) => !("status" in o))).toBe(true);
  }));

test("arbitrary malformed/unsupported fragments remain deterministic and cannot mutate input", () =>
  hegel.test((tc) => {
    const text = tc.draw(gs.text({ maxSize: 160 }));
    const name = tc.draw(
      gs.sampledFrom(["exec", "exec_command", "ruby", "powershell"])
    );
    const call = { name, input: { code: text, cmd: text } };
    const before = JSON.stringify(call);
    expect(analyzeActivity(call, languages)).toEqual(
      analyzeActivity(call, languages)
    );
    expect(JSON.stringify(call)).toBe(before);
    expect(analyzeActivity(call, languages).operations.length).toBeGreaterThan(
      0
    );
  }));

test("generated Python edit implementations absorb their reads without promoting printed source into activities", () =>
  hegel.test((tc) => {
    const reads = tc.draw(gs.integers({ minValue: 0, maxValue: 5 }));
    const writes = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
    const snippet = tc.draw(gs.sampledFrom(commands)).source;
    const program = [
      "from pathlib import Path",
      "p = Path('src/generated.py')",
      ...Array.from({ length: reads }, () => "before = p.read_text()"),
      ...Array.from(
        { length: writes },
        () => `p.write_text(${JSON.stringify(snippet)})`
      ),
    ].join("\n");
    const row = shell(`python3 - <<'PY_END'\n${program}\nPY_END\n`);
    expect(labels(row)).toEqual(["file edits"]);
    expect(
      row.operations.filter((o) => o.activities.includes("file edits"))
    ).toHaveLength(1);
    const printed = shell(
      `python3 - <<'PY_END'\nprint(${JSON.stringify(`${snippet}; p.write_text('x'); open('a')`)})\nPY_END\n`
    );
    expect(labels(printed)).toEqual([]);
  }));

test("literal shell wrappers preserve their child activities and operation relationships", () =>
  hegel.test((tc) => {
    const leaves = tc.draw(
      gs.arrays(gs.sampledFrom(commands), { minSize: 1, maxSize: 12 })
    );
    const executable = tc.draw(
      gs.sampledFrom(["/bin/zsh", "/bin/bash", "/bin/sh", "zsh", "bash", "sh"])
    );
    const flag = tc.draw(gs.sampledFrom(["-c", "-lc", "-ic"]));
    const source = leaves.map((l) => l.source).join("; ");
    const wrapped = shell(`${executable} ${flag} ${quote(source)}`);
    const direct = shell(source);
    expect(labels(wrapped)).toEqual(labels(direct));
    expect(
      wrapped.operations.map((o) => ({
        ...o,
        relationships: o.relationships.filter(
          (r) => r !== "shell wrapper (requested)"
        ),
      }))
    ).toEqual(direct.operations);
  }));

test("Git option values and quoted shell operators cannot inject extra commands", () =>
  hegel.test((tc) => {
    const path = tc.draw(
      gs.text({ alphabet: "abc XYZ012/;|&$()\n", maxSize: 70 })
    );
    const row = shell(
      `git -C ${quote(path)} status; gh pr view 531 --json url; unknown-command --text ${quote(path)}`
    );
    expect(labels(row)).toEqual(["Git inspection", "GitHub inspection"]);
    expect(
      row.operations.filter((op) => op.decisionEligible).map((op) => op.source)
    ).toEqual([`unknown-command --text ${quote(path)}`]);
  }));
