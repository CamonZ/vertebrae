import { activityLabel } from "./grouping";
import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Parser, Language } from "web-tree-sitter";
import { analyzeActivity } from "./parser";
import type { ActivityAnalysis } from "./types";
let languages: Record<"javascript" | "bash" | "python", Language>;
beforeAll(async () => {
  await Parser.init({
    wasmBinary: await readFile("node_modules/web-tree-sitter/tree-sitter.wasm"),
  });
  const [javascript, bash, python] = await Promise.all(
    ["javascript", "bash", "python"].map((l) =>
      readFile(`node_modules/tree-sitter-wasms/out/tree-sitter-${l}.wasm`).then(
        (bytes) => Language.load(new Uint8Array(bytes))
      )
    )
  );
  languages = { javascript, bash, python };
});
const labels = (r: ActivityAnalysis) =>
  [...new Set(r.operations.flatMap((o) => o.activities))].sort();
const shell = (cmd: string) =>
  analyzeActivity({ name: "exec_command", input: { cmd } }, languages);
const js = (code: string) =>
  analyzeActivity({ name: "exec", input: { code } }, languages);
describe("requested activity syntax", () => {
  it("recognizes multiple activities, deduplicates labels and keeps literal evidence", () => {
    const r = shell(
      "cat src/main.rs; rg timeout src; cargo test; cat docs/testing.md"
    );
    expect(labels(r)).toEqual([
      "checks",
      "documentation",
      "source inspection",
      "source search",
    ]);
    expect(r.operations.some((o) => o.targets?.includes("src/main.rs"))).toBe(
      true
    );
  });
  it.each([
    [";", "sequence"],
    ["&&", "on success"],
    ["||", "on failure"],
    ["|", "pipeline"],
    ["&", "background / parallel"],
  ])(
    "retains %s relationships without claiming execution",
    (operator, relation) => {
      const r = shell(`cargo test ${operator} git status`);
      expect(r.operations.flatMap((o) => o.relationships)).toContain(relation);
      expect(r.operations.every((o) => !("status" in o))).toBe(true);
    }
  );
  it("does not classify quoted patterns, comments, data objects or heredoc contents as invocations", () => {
    expect(
      labels(shell('rg "cargo test|git status" src # cat docs/test.md'))
    ).toEqual(["source search"]);
    expect(
      labels(js('const data = {cmd: "cargo test"}; // tools.apply_patch("x")'))
    ).toEqual([]);
    expect(
      labels(shell("cat > /tmp/x <<'EOF'\ncargo test\ngit status\nEOF"))
    ).toEqual(["file edits"]);
  });
  it("parses nested direct calls while retaining indirect arguments as unresolved", () => {
    const r = js(
      'await Promise.all([tools.exec_command({cmd:"cargo test"}), tools.exec_command({cmd:"git status"}), tools.exec_command(args)]);'
    );
    expect(labels(r)).toEqual(["Git inspection", "checks"]);
    expect(r.operations.some((o) => o.unresolved)).toBe(true);
    expect(r.operations.flatMap((o) => o.relationships)).toContain(
      "parallel requests"
    );
  });
  it("keeps pipeline filters from becoming file searches", () => {
    expect(labels(shell("git diff | grep cargo | head -20"))).toEqual([
      "Git inspection",
    ]);
  });
  it("handles embedded Python edits without counting implementation reads", () => {
    expect(
      labels(
        shell(
          "python3 - <<'PY'\nfrom pathlib import Path\np=Path('a.py')\ns=p.read_text()\np.write_text(s)\nPY"
        )
      )
    ).toEqual(["file edits"]);
  });
  it.each([
    "ruby -e 'puts :git'",
    "pwsh -Command 'Get-Content a.rs'",
    "./opaque.sh",
    "cat $FILE",
    "cargo test &&",
    "python3 script.py",
  ])("retains uncertainty for %s", (cmd) => {
    expect(shell(cmd).operations.some((o) => o.unresolved)).toBe(true);
  });
  it("preserves supported work alongside unsupported operations", () => {
    const r = shell("cargo test; ruby mystery.rb");
    expect(labels(r)).toEqual(["checks"]);
    expect(r.operations.some((o) => o.unresolved)).toBe(true);
  });
});

// Constructed controls from the external prototype, never historical transcripts.
import controls from "./prototype-controls.json";
const vocabulary: Record<string, string> = {
  read_docs: "documentation",
  read_source: "source inspection",
  run_checks: "checks",
  search_source: "source search",
  edit_files: "file edits",
  inspect_git: "Git inspection",
  manage_records: "task management",
  manage_environment: "environment management",
  web_research: "web requests",
};
it("matches the prototype's 25 constructed activity-set controls", () => {
  const mismatches = controls.flatMap((c) => {
    const actual = labels(js(c.input));
    const expected = c.gold.map((g) => vocabulary[g]).sort();
    return JSON.stringify(actual) === JSON.stringify(expected)
      ? []
      : [{ id: c.id, actual, expected }];
  });
  expect(mismatches).toEqual([]);
});

it("keeps repeated submitted operations while deduplicating only activity labels", () => {
  const r = shell("cargo test; cargo test");
  expect(r.operations).toHaveLength(2);
  expect(labels(r)).toEqual(["checks"]);
});
it("does not classify a deferred shell function or overridden dynamic arguments", () => {
  expect(
    labels(shell("function inspect() { cat src/a.rs; }; echo ready"))
  ).toEqual([]);
  expect(
    labels(js('tools.exec_command({cmd:"cargo test", ...overrides})'))
  ).toEqual([]);
  expect(
    labels(js('tools.exec_command({cmd:"cargo test", shell:dynamicShell})'))
  ).toEqual([]);
});

it("unwraps recorded literal login-shell commands while preserving quoted paths", () => {
  const r = shell(
    `/bin/zsh -lc "cat 'docs/agent-session-contract.md'; git status; cargo test"`
  );
  expect(labels(r)).toEqual(["Git inspection", "checks", "documentation"]);
  expect(r.operations[0].targets?.[0]).toBe("docs/agent-session-contract.md");
  expect(
    r.operations.every((o) =>
      o.relationships.includes("shell wrapper (requested)")
    )
  ).toBe(true);
});
it("leaves dynamic and positional shell wrappers unresolved exactly once", () => {
  for (const source of [
    "/bin/zsh -lc $SCRIPT",
    "bash -c 'cargo test' extra",
    "fish -c 'cargo test'",
  ]) {
    const row = shell(source);
    expect(labels(row)).toEqual([]);
    expect(row.operations).toHaveLength(1);
    expect(row.operations[0].unresolved).toBeTruthy();
  }
});

it("keeps the reported tail command as a read, never an edit", () => {
  const row = shell("tail -20 /tmp/c3217b2e-signal-tests.log");
  expect(activityLabel([row])).toBe("source inspection");
  expect(row.operations[0].targets?.[0]).toBe("/tmp/c3217b2e-signal-tests.log");
});

it("splits mixed Git, GitHub and unknown invocations without splitting quoted data", () => {
  const row = shell(
    `git -C /repo status && gh pr view 531 --json url | jq '.url'; mystery --message 'git commit; gh pr merge'`
  );
  expect(labels(row)).toEqual(["Git inspection", "GitHub inspection"]);
  expect(
    row.operations.filter((op) => op.decisionEligible).map((op) => op.source)
  ).toEqual(["mystery --message 'git commit; gh pr merge'"]);
  expect(
    row.operations.some((op) => op.source === "gh pr view 531 --json url")
  ).toBe(true);
});

it("does not offer malformed, deferred, or opaque bundled source to the decision model", () => {
  for (const cmd of [
    "echo '",
    "function later() { mystery; }",
    `bash -c "$PAYLOAD"`,
    "cat <<'EOF'\nmystery; git commit\nEOF\n",
  ]) {
    expect(shell(cmd).operations.some((op) => op.decisionEligible)).toBe(false);
  }
});

it("offers unresolved Python as one invocation with its own script context, excluding sibling commands", () => {
  const row = shell(
    "python3 - <<'PY'\nfrom pathlib import Path\np = Path('/tmp/a')\nf = p.open('w')\nf.write('new')\nPY\ngit status"
  );
  const sources = row.operations
    .filter((op) => op.decisionEligible)
    .map((op) => op.source);
  expect(sources).toHaveLength(1);
  expect(sources[0]).toContain("f.write('new')");
  expect(sources[0]).not.toContain("git status");
  expect(labels(row)).toEqual(["Git inspection"]);
});

it.each([
  ["npm run build", "builds"],
  ["npm --prefix crates/gui run build", "builds"],
  ["cargo build --release", "builds"],
  ["scripts/validate.sh gui", "checks"],
  ["./scripts/validate gui", "checks"],
  ["npm run typecheck", "checks"],
  ["npm run mystery -- build", undefined],
  ["npm exec echo build", undefined],
  ["echo scripts/validate.sh", undefined],
])("classifies the requested development task in %s", (command, activity) => {
  expect(labels(shell(command))).toEqual(activity ? [activity] : []);
});

it("keeps backtick-shaped text in quoted heredocs out of activity inference", () => {
  const row = shell(
    "cat > /tmp/generated.txt <<'PAYLOAD_END'\n\\0`\ncargo test\n`\nPAYLOAD_END\n"
  );
  expect(labels(row)).toEqual(["file edits"]);
  expect(row.operations.some((op) => op.decisionEligible)).toBe(false);
});

it("keeps mixed Python evidence in one eligible command with the complete script", () => {
  const command =
    "python3 - <<'PY'\nfrom pathlib import Path\ndata = Path('input.txt').read_text()\nPath('output.txt').open('w').write(data)\nPY\n";
  const row = analyzeActivity({ name: "Bash", input: { command } }, languages);
  expect(row.operations).toHaveLength(1);
  expect(row.operations[0]).toMatchObject({
    activities: ["source inspection"],
    decisionEligible: true,
  });
  expect(row.operations[0].source).toContain(".open('w').write(data)");
});

it("keeps identical sibling commands distinct while collecting each command's targets", () => {
  const row = analyzeActivity(
    {
      name: "Bash",
      input: { command: "cat src/a.rs docs/a.md; cat src/a.rs docs/a.md" },
    },
    languages
  );
  expect(row.operations).toHaveLength(2);
  for (const operation of row.operations) {
    expect(operation.activities).toEqual([
      "source inspection",
      "documentation",
    ]);
    expect(operation.targets).toEqual(["src/a.rs", "docs/a.md"]);
  }
});

it.each([
  ["mcp__hammerspoon_gui__gui_ui_elements_app", ["visual inspection"]],
  ["mcp__hammerspoon-gui__gui_screenshot_window", ["visual inspection"]],
  ["view_image", ["visual inspection"]],
  ["mcp__hammerspoon_gui__gui_click", ["UI interaction"]],
  [
    "mcp__hammerspoon_gui__gui_click_and_screenshot",
    ["UI interaction", "visual inspection"],
  ],
  ["Agent", ["coordination"]],
  ["SendMessage", ["coordination"]],
  ["AskUserQuestion", ["coordination"]],
  ["followup_task", ["coordination"]],
  ["write_stdin", ["environment management"]],
  ["sleep", ["environment management"]],
  ["mcp__tidewave__get_logs", ["runtime inspection"]],
  ["tidewave.get_models", ["runtime inspection"]],
  ["mcp__tidewave__get_docs", ["documentation"]],
])(
  "recognizes %s from its tool contract without inference",
  (name, activities) => {
    const row = analyzeActivity({ name, input: {} }, languages);
    expect(row.operations).toHaveLength(1);
    expect(row.operations[0].activities).toEqual(activities);
    expect(row.operations[0].decisionEligible).not.toBe(true);
  }
);

it.each([
  ["mcp__tidewave__project_eval", { code: "Repo.all(User)" }],
  ["mcp__tidewave__project_eval", { code: "Repo.delete_all(User)" }],
  ["mcp__tidewave__execute_sql_query", { query: "SELECT * FROM users" }],
  ["mcp__tidewave__execute_sql_query", { query: "DELETE FROM users" }],
])(
  "keeps %s intent input-dependent, including mutating evaluations",
  (name, input) => {
    const row = analyzeActivity({ name, input }, languages);
    expect(row.operations).toHaveLength(1);
    expect(row.operations[0].activities).toEqual([]);
    expect(row.operations[0].decisionEligible).toBe(true);
    expect(JSON.parse(row.operations[0].source)).toEqual({ tool: name, input });
  }
);

it("keeps MCP invocation context inside JavaScript wrappers", () => {
  const row = js(
    'await tools.mcp__tidewave__execute_sql_query({query: "SELECT 1"});'
  );
  expect(row.operations).toHaveLength(1);
  expect(row.operations[0].decisionEligible).toBe(true);
  expect(JSON.parse(row.operations[0].source)).toEqual({
    tool: "mcp__tidewave__execute_sql_query",
    input: { query: "SELECT 1" },
  });
});
