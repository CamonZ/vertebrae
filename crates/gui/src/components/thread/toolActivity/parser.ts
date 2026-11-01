import { classifyCommand, classifyTool } from "./classification";
import { Parser, Language, type Node } from "web-tree-sitter";
import type { ActivityAnalysis, ActivityInput, Operation } from "./types";

type Languages = Record<"javascript" | "bash" | "python", Language>;
const children = (n: Node) =>
  n.namedChildren.filter((c): c is Node => c !== null);
const field = (n: Node, key: string) => n.childForFieldName(key);
function* walk(n: Node): Generator<Node> {
  yield n;
  for (const child of children(n)) yield* walk(child);
}

/** No evaluation, interpolation, subprocesses, or filesystem access. */
export function analyzeActivity(
  call: ActivityInput,
  languages: Languages
): ActivityAnalysis {
  const operations: Operation[] = [];
  const add = (
    source: string,
    relationships: string[],
    activity?: string,
    target?: string,
    unresolved?: string,
    decisionEligible?: boolean
  ) =>
    operations.push({
      source,
      relationships,
      activities: activity ? [activity] : [],
      targets: target ? [target] : [],
      unresolved,
      ...(decisionEligible ? { decisionEligible } : {}),
    });
  const unknown = (
    source: string,
    relationships: string[],
    reason: string,
    decisionEligible = false
  ) =>
    add(source, relationships, undefined, undefined, reason, decisionEligible);
  function parse(
    code: string,
    language: keyof Languages,
    consume: (root: Node) => void
  ) {
    const parser = new Parser();
    parser.setLanguage(languages[language]);
    const tree = parser.parse(code);
    try {
      if (!tree || tree.rootNode.hasError) {
        unknown(code, [], `${language} syntax incomplete or unsupported`);
        return false;
      }
      consume(tree.rootNode);
      return true;
    } finally {
      tree?.delete();
      parser.delete();
    }
  }
  function literal(n: Node | null): string | undefined {
    if (!n) return;
    if (
      ["word", "number", "identifier", "property_identifier"].includes(n.type)
    )
      return n.text;
    if (
      n.type === "string" ||
      n.type === "raw_string" ||
      n.type === "template_string"
    ) {
      if (
        [...walk(n)].some((c) =>
          [
            "template_substitution",
            "expansion",
            "simple_expansion",
            "command_substitution",
          ].includes(c.type)
        )
      )
        return;
      // Decode only escapes, never evaluate JavaScript or shell source.
      return n.text
        .slice(1, -1)
        .replace(
          /\\(\\|"|'|`|n|r|t)/g,
          (_, c: string) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c
        );
    }
  }
  function shellLiteral(n: Node): string | undefined {
    if (n.type === "raw_string") return n.text.slice(1, -1);
    if (n.type === "string") {
      if (
        [...walk(n)].some((c) =>
          ["expansion", "simple_expansion", "command_substitution"].includes(
            c.type
          )
        )
      )
        return;
      // Shell double quotes only unescape $, `, ", backslash and line continuation.
      return n.text
        .slice(1, -1)
        .replace(/\\([$`"\\\n])/g, (_, c: string) => (c === "\n" ? "" : c));
    }
    return literal(n);
  }
  function relationships(n: Node, inherited: string[]): string[] {
    const out = [...inherited];
    for (let p: Node | null = n.parent; p; p = p.parent) {
      if (
        [
          "list",
          "pipeline",
          "program",
          "if_statement",
          "while_statement",
          "for_statement",
        ].includes(p.type)
      ) {
        for (const c of p.children.filter((c): c is Node => c !== null)) {
          const label = (
            {
              ";": "sequence",
              "&&": "on success",
              "||": "on failure",
              "|": "pipeline",
              "&": "background / parallel",
            } as Record<string, string>
          )[c.type];
          if (label && !out.includes(label)) {
            // A condition governs only the right side of its list expression.
            if (
              (c.type === "&&" || c.type === "||") &&
              n.startIndex < c.endIndex
            )
              continue;
            out.push(label);
          }
        }
        if (p.type.endsWith("statement")) out.push("conditional / repeated");
      }
    }
    return out;
  }
  function python(code: string, rel: string[]) {
    return parse(code, "python", (root) => {
      const start = operations.length;
      for (const n of walk(root)) {
        if (n.type !== "call") continue;
        const f = field(n, "function");
        const args =
          field(n, "arguments")?.namedChildren.filter(
            (c): c is Node => c !== null
          ) ?? [];
        const name = f?.text ?? "";
        if (
          name.endsWith(".write_text") ||
          name.endsWith(".write_bytes") ||
          (name === "open" && /[wax]/.test(literal(args[1]) ?? ""))
        )
          add(n.text, rel, "file edits", f?.text);
        else if (
          name === "open" ||
          name.endsWith(".read_text") ||
          name.endsWith(".read_bytes")
        )
          add(n.text, rel, "source inspection", literal(args[0]) ?? f?.text);
        else unknown(n.text, rel, "Unsupported Python call");
      }
      if (
        operations.slice(start).some((o) => o.activities.includes("file edits"))
      ) {
        for (let i = operations.length - 1; i >= start; i--)
          if (operations[i].activities.includes("source inspection"))
            operations.splice(i, 1);
      }
    });
  }
  function shell(code: string, inherited: string[] = []) {
    parse(code, "bash", (root) => {
      for (const n of walk(root)) {
        if (n.type !== "command") continue;
        const rel = relationships(n, inherited);
        const start = operations.length;
        let wrapper = false;
        try {
          let deferred = false;
          for (let p = n.parent; p; p = p.parent) {
            if (
              [
                "function_definition",
                "heredoc_body",
                "heredoc_redirect",
              ].includes(p.type)
            )
              deferred = true;
            if (p.type === "command_substitution")
              rel.push("nested command substitution");
          }
          if (deferred) {
            unknown(
              n.text,
              rel,
              "Deferred function or payload; invocation unresolved"
            );
            continue;
          }
          const nameNode = field(n, "name");
          const name = nameNode?.text ?? "";
          const nodes = children(n).filter(
            (c) => c.id !== nameNode?.id && c.type !== "variable_assignment"
          );
          const args = nodes.map(shellLiteral);
          const words = args.filter((a): a is string => a !== undefined);
          const shellWrapper = ["sh", "bash", "zsh"].includes(
            name.split("/").slice(-1)[0]
          );
          if (args.some((a) => a === undefined) && !shellWrapper)
            unknown(n.text, rel, "Dynamic or unsupported argument");
          let pipelineFilter = false;
          if (n.parent?.type === "pipeline")
            pipelineFilter = children(n.parent)[0]?.id !== n.id;
          const redirects =
            n.parent?.type === "redirected_statement" ? children(n.parent) : [];
          const writes = redirects.filter(
            (r) => r.type === "file_redirect" && /^(?:1)?\s*>>?/.test(r.text)
          );
          if (
            writes.length &&
            ["cat", "echo", "printf", "tee"].includes(name)
          ) {
            add(
              n.text,
              rel,
              "file edits",
              writes.map((r) => r.text).join(", ")
            );
            continue;
          }
          if (shellWrapper) {
            wrapper = true;
            if (
              args.length === 2 &&
              args[0] !== undefined &&
              /^-[il]*c[il]*$/.test(args[0]) &&
              args[1] !== undefined
            )
              shell(args[1], [...rel, "shell wrapper (requested)"]);
            else unknown(n.text, rel, "Dynamic or unsupported shell wrapper");
          } else if (["python", "python3"].includes(name)) {
            const bodies = redirects.flatMap((r) =>
              [...walk(r)].filter((c) => c.type === "heredoc_body")
            );
            const valid = bodies.length
              ? bodies.map((b) => python(b.text, rel)).every(Boolean)
              : words.includes("-c")
                ? python(words[words.indexOf("-c") + 1] ?? "", rel)
                : true;
            if (!bodies.length && !words.includes("-c"))
              unknown(n.text, rel, "External Python script", true);
            // Partial syntax knowledge must not prevent questions about the rest of a script.
            if (valid && operations.slice(start).some((op) => op.unresolved))
              operations.slice(start).forEach((op) => {
                op.decisionEligible = true;
              });
          } else if (["cat", "head", "tail", "nl", "sed"].includes(name)) {
            if (name === "sed" && words.some((a) => a.startsWith("-i")))
              add(n.text, rel, "file edits");
            else if (!pipelineFilter) {
              // Only literal path operands, never sed programs or quoted search patterns.
              const paths = nodes
                .filter(
                  (c) =>
                    c.type === "word" ||
                    (name !== "sed" &&
                      ["string", "raw_string"].includes(c.type))
                )
                .map(shellLiteral)
                .filter((a): a is string => a !== undefined)
                .filter(
                  (a) => !a.startsWith("-") && /[/]|\.[a-zA-Z]+$/.test(a)
                );
              for (const path of paths)
                add(
                  n.text,
                  rel,
                  /\.md$|\.rst$|(^|\/)docs\//i.test(path)
                    ? "documentation"
                    : "source inspection",
                  path
                );
              if (!paths.length)
                unknown(n.text, rel, "No literal file operand recognized");
            }
          } else {
            const activity = classifyCommand(name, args, pipelineFilter);
            if (activity !== undefined) add(n.text, rel, activity ?? undefined);
            else unknown(n.text, rel, "Unsupported executable", true);
          }
        } finally {
          if (!wrapper) {
            const evidence = operations.splice(start);
            if (evidence.length)
              operations.push({
                source:
                  n.parent?.type === "redirected_statement"
                    ? n.parent.text
                    : n.text,
                activities: [
                  ...new Set(evidence.flatMap((op) => op.activities)),
                ],
                targets: [
                  ...new Set(evidence.flatMap((op) => op.targets ?? [])),
                ],
                relationships: [
                  ...new Set(evidence.flatMap((op) => op.relationships)),
                ],
                unresolved:
                  [
                    ...new Set(
                      evidence.flatMap((op) =>
                        op.unresolved ? [op.unresolved] : []
                      )
                    ),
                  ].join("; ") || undefined,
                decisionEligible: evidence.some((op) => op.decisionEligible),
              });
          }
        }
      }
    });
  }
  function tool(
    name: string,
    input: Record<string, unknown>,
    rel: string[] = []
  ) {
    const qualifiedName = name;
    name = name.split(".").slice(-1)[0] ?? name;
    if (["exec_command", "Bash", "shell_command"].includes(name)) {
      const code = input.cmd ?? input.command;
      if (
        typeof code === "string" &&
        (!input.shell || /(?:bash|zsh|sh)$/.test(String(input.shell)))
      )
        shell(code, rel);
      else unknown(name, rel, "Unsupported shell or indirect command");
    } else if (["Read", "read_file"].includes(name))
      add(
        name,
        rel,
        "source inspection",
        String(input.file_path ?? input.path ?? "")
      );
    else if (["Edit", "Write", "apply_patch"].includes(name))
      add(
        name,
        rel,
        "file edits",
        typeof input.file_path === "string" ? input.file_path : undefined
      );
    else {
      const activities = classifyTool(qualifiedName);
      if (activities)
        operations.push({
          source: qualifiedName,
          activities,
          relationships: rel,
        });
      else if (/^mcp__|^tidewave\./i.test(qualifiedName))
        unknown(
          JSON.stringify({ tool: qualifiedName, input }),
          rel,
          "MCP activity requires input classification",
          true
        );
      else unknown(name, rel, "Unsupported tool");
    }
  }
  if (["exec", "functions.exec"].includes(call.name)) {
    const code =
      call.input.code ??
      call.input.input ??
      call.input.arguments ??
      call.input.command ??
      call.input.raw;
    if (typeof code !== "string")
      unknown(call.name, [], "Wrapper source unavailable");
    else
      parse(code, "javascript", (root) => {
        for (const n of walk(root)) {
          if (n.type !== "call_expression") continue;
          const f = field(n, "function")?.text ?? "";
          if (!/^tools\.[A-Za-z_][\w]*$/.test(f)) {
            if (
              ![
                "text",
                "image",
                "audio",
                "notify",
                "JSON.stringify",
                "Promise.all",
                "Promise.allSettled",
              ].includes(f)
            )
              unknown(n.text, [], "Unsupported wrapper call");
            continue;
          }
          const object = field(n, "arguments")?.namedChildren[0];
          const input: Record<string, unknown> = {};
          let dynamic = false;
          if (object?.type === "object")
            for (const pair of children(object)) {
              if (pair.type !== "pair") {
                dynamic = true;
                continue;
              }
              const k = field(pair, "key");
              const v = field(pair, "value");
              const key = literal(k);
              const value =
                v && ["string", "template_string"].includes(v.type)
                  ? literal(v)
                  : undefined;
              if (key && value !== undefined) input[key] = value;
              else if (!key || ["cmd", "command", "shell"].includes(key))
                dynamic = true;
            }
          const rel = ["nested invocation (requested)"];
          for (let p = n.parent; p; p = p.parent) {
            if (
              p.type === "call_expression" &&
              /Promise\.(all|allSettled)$/.test(
                field(p, "function")?.text ?? ""
              )
            )
              rel.push("parallel requests");
            if (
              [
                "if_statement",
                "ternary_expression",
                "for_statement",
                "while_statement",
                "function_declaration",
                "arrow_function",
              ].includes(p.type)
            )
              rel.push("conditional / deferred");
          }
          if (dynamic) unknown(n.text, rel, "Dynamic invocation properties");
          else tool(f.slice(6), input, rel);
        }
      });
  } else tool(call.name, call.input);
  if (!operations.length)
    unknown(call.name, [], "No supported operations recognized");
  return { operations };
}
