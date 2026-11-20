use crate::classification::{classify_command, classify_tool, CommandActivity};
use crate::Grammar;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Number;
use std::{
    sync::LazyLock,
    time::{Duration, Instant},
};
use tree_sitter::Node;

#[derive(Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ActivityInput {
    pub name: String,
    #[cfg_attr(feature = "specta", specta(type = serde_json::Map<String, serde_json::Value>))]
    pub input: IndexMap<String, ActivityValue>,
}

/// JSON arguments retain insertion order for stable decision sources.
#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ActivityValue {
    Null,
    Bool(bool),
    Number(Number),
    String(String),
    Array(Vec<Self>),
    Object(IndexMap<String, Self>),
}

impl ActivityValue {
    fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LiteralCommand {
    pub name: String,
    pub args: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub source: String,
    pub activities: Vec<String>,
    pub relationships: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal_command: Option<LiteralCommand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unresolved: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_eligible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inferred_activities: Option<Vec<String>>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ActivityAnalysis {
    pub operations: Vec<Operation>,
}

impl Operation {
    fn new(source: &str, relationships: &[String]) -> Self {
        Self {
            source: source.into(),
            relationships: relationships.to_vec(),
            activities: Vec::new(),
            targets: Some(Vec::new()),
            literal_command: None,
            unresolved: None,
            decision_eligible: None,
            inferred_activities: None,
        }
    }
}

fn text<'a>(node: Node<'_>, source: &'a str) -> &'a str {
    &source[node.byte_range()]
}

fn children(node: Node<'_>) -> Vec<Node<'_>> {
    node.named_children(&mut node.walk()).collect()
}

fn walk(root: Node<'_>) -> impl Iterator<Item = Node<'_>> {
    let mut cursor = root.walk();
    let mut next = Some(root);
    std::iter::from_fn(move || {
        let node = next?;
        if !cursor.goto_first_child() {
            while !cursor.goto_next_sibling() {
                if !cursor.goto_parent() {
                    next = None;
                    return Some(node);
                }
            }
        }
        next = Some(cursor.node());
        Some(node)
    })
    .filter(|node| node.is_named())
}

fn ancestors(node: Node<'_>) -> impl Iterator<Item = Node<'_>> {
    std::iter::successors(node.parent(), Node::parent)
}

fn quoted(text: &str) -> &str {
    text.get(1..text.len().saturating_sub(1))
        .unwrap_or_default()
}

fn decode(text: &str, shell: bool) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let decoded = match (shell, chars.peek()) {
                (true, Some('$' | '`' | '"' | '\\')) | (false, Some('\\' | '"' | '\'' | '`')) => {
                    chars.next()
                }
                (true, Some('\n')) => {
                    chars.next();
                    continue;
                }
                (false, Some('n' | 'r' | 't')) => chars.next().map(|c| match c {
                    'n' => '\n',
                    'r' => '\r',
                    _ => '\t',
                }),
                _ => None,
            };
            if let Some(decoded) = decoded {
                out.push(decoded);
                continue;
            }
        }
        out.push(c);
    }
    out
}

fn literal(node: Node<'_>, source: &str, shell: bool) -> Option<String> {
    let value = text(node, source);
    match node.kind() {
        "word" | "number" | "identifier" | "property_identifier" => Some(value.into()),
        "raw_string" if shell => Some(quoted(value).into()),
        "string" | "raw_string" | "template_string" => {
            if walk(node).any(|child| {
                matches!(
                    child.kind(),
                    "expansion" | "simple_expansion" | "command_substitution"
                ) || (!shell && child.kind() == "template_substitution")
            }) {
                return None;
            }
            Some(decode(quoted(value), shell && node.kind() == "string"))
        }
        _ => None,
    }
}

fn append_unique<T: PartialEq>(output: &mut Vec<T>, items: impl IntoIterator<Item = T>) {
    for item in items {
        if !output.contains(&item) {
            output.push(item);
        }
    }
}

fn shell_relationships(
    node: Node<'_>,
    inherited: &[String],
    deadline: Instant,
) -> Option<Vec<String>> {
    let mut rel = inherited.to_vec();
    for parent in ancestors(node) {
        if Instant::now() >= deadline {
            return None;
        }
        if !matches!(
            parent.kind(),
            "list" | "pipeline" | "program" | "if_statement" | "while_statement" | "for_statement"
        ) {
            continue;
        }
        for child in parent.children(&mut parent.walk()) {
            if Instant::now() >= deadline {
                return None;
            }
            let label = match child.kind() {
                ";" => "sequence",
                "&&" if node.start_byte() >= child.end_byte() => "on success",
                "||" if node.start_byte() >= child.end_byte() => "on failure",
                "|" => "pipeline",
                "&" => "background / parallel",
                _ => continue,
            };
            append_unique(&mut rel, [label.into()]);
        }
        if parent.kind().ends_with("statement") {
            rel.push("conditional / repeated".into());
        }
    }
    Some(rel)
}

fn first_value<'a>(
    input: &'a IndexMap<String, ActivityValue>,
    keys: &[&str],
) -> Option<&'a ActivityValue> {
    keys.iter()
        .filter_map(|key| input.get(*key))
        .find(|value| !matches!(value, ActivityValue::Null))
}

fn js_string(value: &ActivityValue) -> String {
    match value {
        ActivityValue::String(s) => s.clone(),
        ActivityValue::Object(_) => "[object Object]".into(),
        ActivityValue::Number(number) => js_number(number),
        ActivityValue::Array(items) => items
            .iter()
            .map(|item| {
                if matches!(item, ActivityValue::Null) {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        ActivityValue::Bool(value) => value.to_string(),
        ActivityValue::Null => "null".into(),
    }
}

fn js_number(number: &serde_json::Number) -> String {
    number.as_f64().map_or_else(
        || number.to_string(),
        |value| ryu_js::Buffer::new().format(value).into(),
    )
}

fn property_index(key: &str) -> u32 {
    // ECMAScript visits array-index keys first, then other keys in insertion order.
    if key == "0" || (!key.starts_with('0') && key.bytes().all(|b| b.is_ascii_digit())) {
        return key.parse().unwrap_or(u32::MAX);
    }
    u32::MAX
}

fn write_js_object(values: &IndexMap<String, ActivityValue>, output: &mut String) {
    output.push('{');
    let mut entries: Vec<_> = values.iter().collect();
    entries.sort_by_key(|(key, _)| property_index(key));
    for (index, (key, value)) in entries.into_iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&serde_json::to_string(key).expect("JSON string serialization"));
        output.push(':');
        write_js_json(value, output);
    }
    output.push('}');
}

fn write_js_json(value: &ActivityValue, output: &mut String) {
    match value {
        ActivityValue::Number(n) => output.push_str(&js_number(n)),
        ActivityValue::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_js_json(value, output);
            }
            output.push(']');
        }
        ActivityValue::Object(values) => write_js_object(values, output),
        ActivityValue::String(value) => {
            output.push_str(&serde_json::to_string(value).expect("JSON string serialization"));
        }
        ActivityValue::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        ActivityValue::Null => output.push_str("null"),
    }
}

pub fn analyze_activity(call: &ActivityInput) -> ActivityAnalysis {
    analyze_activity_until(call, Instant::now() + Duration::from_millis(100))
}

/// Stop both parsing and evidence collection at the caller's deadline.
pub fn analyze_activity_until(call: &ActivityInput, deadline: Instant) -> ActivityAnalysis {
    let mut analysis = Analyzer {
        operations: Vec::new(),
        deadline,
    };
    if matches!(call.name.as_str(), "exec" | "functions.exec") {
        match first_value(
            &call.input,
            &["code", "input", "arguments", "command", "raw"],
        )
        .and_then(ActivityValue::as_str)
        {
            Some(code) => analysis.javascript(code),
            None => analysis.unknown(&call.name, &[], "Wrapper source unavailable", false),
        }
    } else {
        analysis.tool(&call.name, &call.input, &[]);
    }
    if Instant::now() >= deadline {
        analysis.operations.clear();
        analysis.unknown(
            &call.name,
            &[],
            "Tool activity analysis exceeded its time budget",
            false,
        );
    } else if analysis.operations.is_empty() {
        analysis.unknown(&call.name, &[], "No supported operations recognized", false);
    }
    ActivityAnalysis {
        operations: analysis.operations,
    }
}

struct Analyzer {
    operations: Vec<Operation>,
    deadline: Instant,
}

impl Analyzer {
    fn add(&mut self, source: &str, rel: &[String], activity: Option<&str>, target: Option<&str>) {
        let mut op = Operation::new(source, rel);
        op.activities.extend(activity.map(str::to_owned));
        op.targets = Some(
            target
                .filter(|target| !target.is_empty())
                .map(str::to_owned)
                .into_iter()
                .collect(),
        );
        self.operations.push(op);
    }

    fn unknown(&mut self, source: &str, rel: &[String], reason: &str, eligible: bool) {
        let mut op = Operation::new(source, rel);
        op.unresolved = Some(reason.into());
        op.decision_eligible = eligible.then_some(true);
        self.operations.push(op);
    }

    fn parse(&mut self, grammar: Grammar, code: &str) -> Option<tree_sitter::Tree> {
        if Instant::now() >= self.deadline {
            return None;
        }
        if let Some(tree) = grammar
            .parse_with_deadline(code, Some(self.deadline))
            .filter(|tree| !tree.root_node().has_error())
        {
            return Some(tree);
        }
        self.unknown(
            code,
            &[],
            &format!("{} syntax incomplete or unsupported", grammar.name()),
            false,
        );
        None
    }

    fn tool(&mut self, qualified: &str, input: &IndexMap<String, ActivityValue>, rel: &[String]) {
        let name = qualified.rsplit('.').next().unwrap_or(qualified);
        match name {
            "exec_command" | "Bash" | "shell_command" => {
                let shell_supported = input.get("shell").is_none_or(|value| match value {
                    ActivityValue::Null | ActivityValue::Bool(false) => true,
                    ActivityValue::Number(n) if n.as_f64() == Some(0.) => true,
                    ActivityValue::String(shell) => shell.is_empty() || shell.ends_with("sh"),
                    _ => js_string(value).ends_with("sh"),
                });
                match first_value(input, &["cmd", "command"]).and_then(ActivityValue::as_str) {
                    Some(code) if shell_supported => self.shell(code, rel),
                    _ => self.unknown(name, rel, "Unsupported shell or indirect command", false),
                }
            }
            "Read" | "read_file" => {
                let path = first_value(input, &["file_path", "path"]).map(js_string);
                self.add(name, rel, Some("source inspection"), path.as_deref());
            }
            "Edit" | "Write" | "apply_patch" => {
                self.add(
                    name,
                    rel,
                    Some("file edits"),
                    input.get("file_path").and_then(ActivityValue::as_str),
                );
            }
            _ => {
                let activities = classify_tool(qualified, name);
                let lower = qualified.to_ascii_lowercase();
                if !activities.is_empty() {
                    let mut op = Operation::new(qualified, rel);
                    op.targets = None;
                    op.activities
                        .extend(activities.iter().map(|label| (*label).into()));
                    self.operations.push(op);
                } else if lower.starts_with("mcp__") || lower.starts_with("tidewave.") {
                    // Preserve decision request identities written by the frontend parser.
                    let name = serde_json::to_string(qualified).expect("JSON string serialization");
                    let mut source = format!(r#"{{"tool":{name},"input":"#);
                    write_js_object(input, &mut source);
                    source.push('}');
                    self.unknown(
                        &source,
                        rel,
                        "MCP activity requires input classification",
                        true,
                    );
                } else {
                    self.unknown(name, rel, "Unsupported tool", false);
                }
            }
        }
    }

    fn javascript(&mut self, code: &str) {
        static TOOL: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^tools\.[A-Za-z_][A-Za-z_0-9]*$").unwrap());
        let Some(tree) = self.parse(Grammar::JavaScript, code) else {
            return;
        };
        let deadline = self.deadline;
        for node in walk(tree.root_node())
            .take_while(|_| Instant::now() < deadline)
            .filter(|node| node.kind() == "call_expression")
        {
            let name = node
                .child_by_field_name("function")
                .map_or("", |node| text(node, code));
            if !TOOL.is_match(name) {
                if !matches!(
                    name,
                    "text"
                        | "image"
                        | "audio"
                        | "notify"
                        | "JSON.stringify"
                        | "Promise.all"
                        | "Promise.allSettled"
                ) {
                    self.unknown(text(node, code), &[], "Unsupported wrapper call", false);
                }
                continue;
            }
            let mut input = IndexMap::new();
            let mut dynamic = false;
            if let Some(object) = node
                .child_by_field_name("arguments")
                .and_then(|args| args.named_child(0))
                .filter(|arg| arg.kind() == "object")
            {
                for pair in children(object) {
                    if pair.kind() != "pair" {
                        dynamic = true;
                        continue;
                    }
                    let key = pair
                        .child_by_field_name("key")
                        .and_then(|key| literal(key, code, false));
                    let value = pair
                        .child_by_field_name("value")
                        .filter(|value| matches!(value.kind(), "string" | "template_string"))
                        .and_then(|value| literal(value, code, false));
                    match (key, value) {
                        (Some(key), Some(value)) if !key.is_empty() => {
                            // Assignment of a string to the JS object prototype setter is ignored.
                            if key != "__proto__" {
                                input.insert(key, ActivityValue::String(value));
                            }
                        }
                        (Some(key), _)
                            if !key.is_empty()
                                && !matches!(key.as_str(), "cmd" | "command" | "shell") => {}
                        _ => dynamic = true,
                    }
                }
            }
            let mut rel = vec!["nested invocation (requested)".into()];
            for parent in ancestors(node) {
                if Instant::now() >= deadline {
                    return;
                }
                if parent.kind() == "call_expression"
                    && parent.child_by_field_name("function").is_some_and(|f| {
                        let name = text(f, code);
                        name.ends_with("Promise.all") || name.ends_with("Promise.allSettled")
                    })
                {
                    rel.push("parallel requests".into());
                }
                if matches!(
                    parent.kind(),
                    "if_statement"
                        | "ternary_expression"
                        | "for_statement"
                        | "while_statement"
                        | "function_declaration"
                        | "arrow_function"
                ) {
                    rel.push("conditional / deferred".into());
                }
            }
            if dynamic {
                self.unknown(
                    text(node, code),
                    &rel,
                    "Dynamic invocation properties",
                    false,
                );
            } else {
                self.tool(&name[6..], &input, &rel);
            }
        }
    }

    fn python(&mut self, code: &str, rel: &[String]) -> bool {
        let Some(tree) = self.parse(Grammar::Python, code) else {
            return false;
        };
        let start = self.operations.len();
        let deadline = self.deadline;
        for node in walk(tree.root_node())
            .take_while(|_| Instant::now() < deadline)
            .filter(|node| node.kind() == "call")
        {
            let function = node
                .child_by_field_name("function")
                .map(|node| text(node, code));
            let name = function.unwrap_or_default();
            let arg = |index| {
                node.child_by_field_name("arguments")
                    .and_then(|a| a.named_child(index))
                    .and_then(|a| literal(a, code, false))
            };
            let source = text(node, code);
            if name.ends_with(".write_text")
                || name.ends_with(".write_bytes")
                || (name == "open" && arg(1).is_some_and(|mode| mode.contains(['w', 'a', 'x'])))
            {
                self.add(source, rel, Some("file edits"), function);
            } else if name == "open"
                || name.ends_with(".read_text")
                || name.ends_with(".read_bytes")
            {
                self.add(
                    source,
                    rel,
                    Some("source inspection"),
                    arg(0).as_deref().or(function),
                );
            } else {
                self.unknown(source, rel, "Unsupported Python call", false);
            }
        }
        if self.operations[start..]
            .iter()
            .any(|op| op.activities.iter().any(|a| a == "file edits"))
        {
            let evidence = self.operations.split_off(start);
            self.operations.extend(
                evidence
                    .into_iter()
                    .filter(|op| !op.activities.iter().any(|a| a == "source inspection")),
            );
        }
        true
    }

    fn shell(&mut self, code: &str, inherited: &[String]) {
        let Some(tree) = self.parse(Grammar::Bash, code) else {
            return;
        };
        let deadline = self.deadline;
        for node in walk(tree.root_node())
            .take_while(|_| Instant::now() < deadline)
            .filter(|node| node.kind() == "command")
        {
            let Some(mut rel) = shell_relationships(node, inherited, deadline) else {
                return;
            };
            let mut deferred = false;
            for parent in ancestors(node) {
                if Instant::now() >= deadline {
                    return;
                }
                match parent.kind() {
                    "function_definition" | "heredoc_body" | "heredoc_redirect" => deferred = true,
                    "command_substitution" => rel.push("nested command substitution".into()),
                    _ => {}
                }
            }

            let start = self.operations.len();
            let parent = node.parent();
            let redirected = parent.filter(|p| p.kind() == "redirected_statement");
            let name_node = node.child_by_field_name("name");
            let name = name_node.map_or("", |name| text(name, code));
            let children = children(node);
            let operands: Vec<_> = children
                .iter()
                .copied()
                .filter(|child| Some(*child) != name_node && child.kind() != "variable_assignment")
                .collect();
            let args: Vec<_> = operands
                .iter()
                .map(|arg| literal(*arg, code, true))
                .collect();
            let wrapper = matches!(name.rsplit('/').next(), Some("sh" | "bash" | "zsh"));
            let source = text(node, code);
            if deferred {
                self.unknown(
                    source,
                    &rel,
                    "Deferred function or payload; invocation unresolved",
                    false,
                );
            } else if wrapper {
                static FLAGS: LazyLock<Regex> =
                    LazyLock::new(|| Regex::new(r"^-[il]*c[il]*$").unwrap());
                match args.as_slice() {
                    [Some(flags), Some(payload)] if FLAGS.is_match(flags) => {
                        rel.push("shell wrapper (requested)".into());
                        self.shell(payload, &rel);
                    }
                    _ => self.unknown(source, &rel, "Dynamic or unsupported shell wrapper", false),
                }
                continue;
            } else {
                let words: Vec<_> = args.iter().filter_map(Option::as_deref).collect();
                if args.iter().any(Option::is_none) {
                    self.unknown(source, &rel, "Dynamic or unsupported argument", false);
                }
                let redirects = redirected.map(self::children).unwrap_or_default();
                let pipeline_filter = parent
                    .is_some_and(|p| p.kind() == "pipeline" && p.named_child(0) != Some(node));
                self.shell_evidence(ShellCommand {
                    source,
                    name,
                    code,
                    rel: &rel,
                    operands: &operands,
                    args: &args,
                    words: &words,
                    redirects: &redirects,
                    pipeline_filter,
                    start,
                });
            }

            let literal_command = (!deferred
                && parent.is_some_and(|p| p.kind() == "program")
                && !children
                    .iter()
                    .any(|child| child.kind() == "variable_assignment"))
            .then(|| args.into_iter().collect::<Option<Vec<_>>>())
            .flatten()
            .map(|args| LiteralCommand {
                name: name.into(),
                args,
            });
            self.merge_shell(
                start,
                redirected.map_or(source, |p| text(p, code)),
                literal_command,
            );
        }
    }

    fn merge_shell(&mut self, start: usize, source: &str, literal_command: Option<LiteralCommand>) {
        if self.operations.len() == start {
            return;
        }
        let mut merged = Operation::new(source, &[]);
        let mut targets = Vec::new();
        let mut unresolved = Vec::new();
        let mut eligible = false;
        for op in self.operations.drain(start..) {
            append_unique(&mut merged.activities, op.activities);
            append_unique(&mut merged.relationships, op.relationships);
            append_unique(&mut targets, op.targets.into_iter().flatten());
            append_unique(&mut unresolved, op.unresolved);
            eligible |= op.decision_eligible == Some(true);
        }
        merged.targets = Some(targets);
        merged.unresolved = (!unresolved.is_empty()).then(|| unresolved.join("; "));
        merged.decision_eligible = Some(eligible);
        merged.literal_command = literal_command;
        self.operations.push(merged);
    }

    fn shell_evidence(&mut self, command: ShellCommand<'_, '_>) {
        let ShellCommand {
            source,
            name,
            code,
            rel,
            operands,
            args,
            words,
            redirects,
            pipeline_filter,
            start: _,
        } = command;
        static WRITE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^1?\s*>").unwrap());
        static PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/|\.[a-zA-Z]+$").unwrap());
        static DOC: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(?i)\.md$|\.rst$|(^|/)docs/").unwrap());
        let writes: Vec<_> = redirects
            .iter()
            .filter(|r| r.kind() == "file_redirect" && WRITE.is_match(text(**r, code)))
            .map(|r| text(*r, code))
            .collect();
        if !writes.is_empty() && matches!(name, "cat" | "echo" | "printf" | "tee") {
            self.add(source, rel, Some("file edits"), Some(&writes.join(", ")));
            return;
        }
        match name {
            "python" | "python3" => self.shell_python(&command),
            "sed" if words.iter().any(|word| word.starts_with("-i")) => {
                self.add(source, rel, Some("file edits"), None)
            }
            "cat" | "head" | "tail" | "nl" | "sed" => {
                if pipeline_filter {
                    return;
                }
                let start = self.operations.len();
                for (node, arg) in operands.iter().zip(args) {
                    if node.kind() != "word"
                        && (name == "sed" || !matches!(node.kind(), "string" | "raw_string"))
                    {
                        continue;
                    }
                    if let Some(path) = arg
                        .as_deref()
                        .filter(|path| !path.starts_with('-') && PATH.is_match(path))
                    {
                        let label = if DOC.is_match(path) {
                            "documentation"
                        } else {
                            "source inspection"
                        };
                        self.add(source, rel, Some(label), Some(path));
                    }
                }
                if self.operations.len() == start {
                    self.unknown(source, rel, "No literal file operand recognized", false);
                }
            }
            _ => match classify_command(name, args, pipeline_filter) {
                CommandActivity::Known(label) => self.add(source, rel, label, None),
                CommandActivity::Unknown => {
                    self.unknown(source, rel, "Unsupported executable", true)
                }
            },
        }
    }

    fn shell_python(&mut self, command: &ShellCommand<'_, '_>) {
        let ShellCommand {
            source,
            code,
            rel,
            words,
            redirects,
            start,
            ..
        } = *command;
        let bodies: Vec<_> = redirects
            .iter()
            .flat_map(|node| walk(*node))
            .filter(|node| node.kind() == "heredoc_body")
            .collect();
        let valid = if bodies.is_empty() {
            if let Some(index) = words.iter().position(|word| *word == "-c") {
                self.python(words.get(index + 1).copied().unwrap_or_default(), rel)
            } else {
                self.unknown(source, rel, "External Python script", true);
                true
            }
        } else {
            let mut valid = true;
            for body in bodies {
                valid &= self.python(text(body, code), rel);
            }
            valid
        };
        if valid
            && self.operations[start..]
                .iter()
                .any(|op| op.unresolved.is_some())
        {
            for op in &mut self.operations[start..] {
                op.decision_eligible = Some(true);
            }
        }
    }
}

struct ShellCommand<'a, 'tree> {
    source: &'a str,
    name: &'a str,
    code: &'a str,
    rel: &'a [String],
    operands: &'a [Node<'tree>],
    args: &'a [Option<String>],
    words: &'a [&'a str],
    redirects: &'a [Node<'tree>],
    pipeline_filter: bool,
    start: usize,
}
