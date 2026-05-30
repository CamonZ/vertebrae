use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use clap::{Arg, ArgAction, CommandFactory};
use include_dir::{Dir, include_dir};
use serde::Serialize;
use vertebrae_core::SectionType;

use crate::CliArgs;

const MANIFEST_SCHEMA_VERSION: u32 = 1;
const SKILL_MANIFEST_ROOTS: &[&str] = &["skills"];
const SKILLS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../skills");

#[derive(Debug, Clone, Serialize)]
pub struct CliManifest {
    pub schema_version: u32,
    pub binary: String,
    pub version: Option<String>,
    pub about: Option<String>,
    pub generated_from: &'static str,
    pub json_support: JsonSupport,
    pub global_args: Vec<ManifestArg>,
    pub commands: Vec<ManifestCommand>,
    pub locally_modelled: LocalMetadata,
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonSupport {
    pub global_flag: &'static str,
    pub default_for_commands: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalMetadata {
    pub section_types: Vec<&'static str>,
    pub skill_manifest_roots: &'static [&'static str],
}

#[derive(Debug, Clone, Serialize)]
pub struct ManifestCommand {
    pub name: String,
    pub path: Vec<String>,
    pub about: Option<String>,
    pub long_about: Option<String>,
    pub visible_aliases: Vec<String>,
    pub hidden_aliases: Vec<String>,
    pub visible_short_flag_aliases: Vec<char>,
    pub hidden_short_flag_aliases: Vec<char>,
    pub visible_long_flag_aliases: Vec<String>,
    pub hidden_long_flag_aliases: Vec<String>,
    pub hidden: bool,
    pub deprecated: bool,
    pub json_supported: bool,
    pub examples_hook: Option<String>,
    pub args: Vec<ManifestArg>,
    pub subcommands: Vec<ManifestCommand>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManifestArg {
    pub id: String,
    pub kind: ArgKind,
    pub help: Option<String>,
    pub long_help: Option<String>,
    pub short: Option<char>,
    pub long: Option<String>,
    pub visible_aliases: Vec<String>,
    pub hidden_aliases: Vec<String>,
    pub visible_short_aliases: Vec<char>,
    pub hidden_short_aliases: Vec<char>,
    pub required: bool,
    pub global: bool,
    pub hidden: bool,
    pub action: String,
    pub num_args: Option<String>,
    pub value_names: Vec<String>,
    pub default_values: Vec<String>,
    pub possible_values: Vec<ManifestPossibleValue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArgKind {
    Positional,
    Option,
    Flag,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManifestPossibleValue {
    pub name: String,
    pub aliases: Vec<String>,
    pub help: Option<String>,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub file: PathBuf,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ValidationReport {
    pub issues: Vec<ValidationIssue>,
}

impl ValidationReport {
    pub fn is_ok(&self) -> bool {
        self.issues.is_empty()
    }

    pub fn render(&self) -> String {
        if self.is_ok() {
            return "CLI docs validation passed".to_string();
        }

        let mut output = String::new();
        let _ = writeln!(
            output,
            "CLI docs validation failed with {} issue(s):",
            self.issues.len()
        );
        for issue in &self.issues {
            let _ = writeln!(output, "- {}: {}", issue.file.display(), issue.message);
        }
        output.trim_end().to_string()
    }
}

pub fn build_manifest() -> CliManifest {
    let root = CliArgs::command();
    let global_args = root
        .get_arguments()
        .filter(|arg| arg.is_global_set())
        .map(manifest_arg)
        .collect();
    let commands = root
        .get_subcommands()
        .map(|cmd| manifest_command(cmd, Vec::new()))
        .collect();

    CliManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        binary: root.get_name().to_string(),
        version: root.get_version().map(ToString::to_string),
        about: root.get_about().map(ToString::to_string),
        generated_from: "clap CommandFactory for vertebrae_cli::CliArgs",
        json_support: JsonSupport {
            global_flag: "--json",
            default_for_commands: true,
        },
        global_args,
        commands,
        locally_modelled: LocalMetadata {
            section_types: supported_section_types(),
            skill_manifest_roots: SKILL_MANIFEST_ROOTS,
        },
    }
}

pub fn manifest_json() -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(&build_manifest())
}

pub fn validate_docs(repo_root: &Path) -> ValidationReport {
    let manifest = build_manifest();
    validate_docs_with_manifest(repo_root, &manifest)
}

fn validate_docs_with_manifest(repo_root: &Path, manifest: &CliManifest) -> ValidationReport {
    let mut issues = Vec::new();
    let command_lookup = command_lookup(manifest);
    let flag_lookup = flag_lookup(&command_lookup);

    if !repo_root.is_dir() {
        issues.push(ValidationIssue {
            file: repo_root.to_path_buf(),
            message: "repository root does not exist or is not a directory".to_string(),
        });
        return ValidationReport { issues };
    }

    let guide_pages = read_guide_pages(repo_root, &mut issues);
    for (guide_page, content) in &guide_pages {
        validate_markdown_content(
            guide_page,
            content,
            &command_lookup,
            &flag_lookup,
            &mut issues,
        );
        validate_section_types_in_content(guide_page, content, &mut issues);
    }
    validate_guide_command_coverage(
        &repo_root.join("docs/vtb-guide.md"),
        guide_pages.iter().map(|(_, content)| content.as_str()),
        manifest,
        &command_lookup,
        &mut issues,
    );

    for root in SKILL_MANIFEST_ROOTS {
        let skill_root = repo_root.join(root);
        if !skill_root.exists() {
            issues.push(ValidationIssue {
                file: skill_root,
                message: "required skills directory is missing".to_string(),
            });
            continue;
        }
        for skill_doc in skill_docs(&skill_root) {
            match fs::read_to_string(&skill_doc) {
                Ok(content) => {
                    validate_markdown_content(
                        &skill_doc,
                        &content,
                        &command_lookup,
                        &flag_lookup,
                        &mut issues,
                    );
                    validate_section_types_in_content(&skill_doc, &content, &mut issues);
                }
                Err(_) => issues.push(ValidationIssue {
                    file: skill_doc,
                    message: "could not read markdown file".to_string(),
                }),
            }
        }
    }

    ValidationReport { issues }
}

fn manifest_command(cmd: &clap::Command, parent: Vec<String>) -> ManifestCommand {
    let mut path = parent;
    path.push(cmd.get_name().to_string());

    let visible_aliases: Vec<String> = cmd.get_visible_aliases().map(ToString::to_string).collect();
    let hidden_aliases: Vec<String> = cmd.get_aliases().map(ToString::to_string).collect();
    let visible_short_flag_aliases: Vec<char> = cmd.get_visible_short_flag_aliases().collect();
    let hidden_short_flag_aliases = hidden_chars(
        cmd.get_all_short_flag_aliases().collect(),
        &visible_short_flag_aliases,
    );
    let visible_long_flag_aliases: Vec<String> = cmd
        .get_visible_long_flag_aliases()
        .map(ToString::to_string)
        .collect();
    let hidden_long_flag_aliases = hidden_strings(
        cmd.get_all_long_flag_aliases()
            .map(ToString::to_string)
            .collect(),
        &visible_long_flag_aliases,
    );

    ManifestCommand {
        name: cmd.get_name().to_string(),
        path: path.clone(),
        about: cmd.get_about().map(ToString::to_string),
        long_about: cmd.get_long_about().map(ToString::to_string),
        visible_aliases,
        hidden_aliases,
        visible_short_flag_aliases,
        hidden_short_flag_aliases,
        visible_long_flag_aliases,
        hidden_long_flag_aliases,
        hidden: cmd.is_hide_set(),
        deprecated: false,
        json_supported: true,
        examples_hook: examples_hook(&path),
        args: cmd.get_arguments().map(manifest_arg).collect(),
        subcommands: cmd
            .get_subcommands()
            .map(|sub| manifest_command(sub, path.clone()))
            .collect(),
    }
}

fn manifest_arg(arg: &Arg) -> ManifestArg {
    let visible_aliases = arg
        .get_visible_aliases()
        .unwrap_or_default()
        .into_iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let hidden_aliases = hidden_strings(
        arg.get_all_aliases()
            .unwrap_or_default()
            .into_iter()
            .map(ToString::to_string)
            .collect(),
        &visible_aliases,
    );
    let visible_short_aliases = arg.get_visible_short_aliases().unwrap_or_default();
    let hidden_short_aliases = hidden_chars(
        arg.get_all_short_aliases().unwrap_or_default(),
        &visible_short_aliases,
    );
    let action = format!("{:?}", arg.get_action());
    let possible_values = possible_values(arg);

    ManifestArg {
        id: arg.get_id().to_string(),
        kind: arg_kind(arg),
        help: arg.get_help().map(ToString::to_string),
        long_help: arg.get_long_help().map(ToString::to_string),
        short: arg.get_short(),
        long: arg.get_long().map(ToString::to_string),
        visible_aliases,
        hidden_aliases,
        visible_short_aliases,
        hidden_short_aliases,
        required: arg.is_required_set(),
        global: arg.is_global_set(),
        hidden: arg.is_hide_set(),
        action,
        num_args: arg.get_num_args().map(|range| format!("{:?}", range)),
        value_names: arg
            .get_value_names()
            .unwrap_or_default()
            .iter()
            .map(ToString::to_string)
            .collect(),
        default_values: arg
            .get_default_values()
            .iter()
            .map(|value| value.as_os_str().to_string_lossy().into_owned())
            .collect(),
        possible_values,
    }
}

fn possible_values(arg: &Arg) -> Vec<ManifestPossibleValue> {
    let mut values: Vec<ManifestPossibleValue> = arg
        .get_possible_values()
        .into_iter()
        .map(|value| ManifestPossibleValue {
            name: value.get_name().to_string(),
            aliases: value
                .get_name_and_aliases()
                .filter(|alias| *alias != value.get_name())
                .map(ToString::to_string)
                .collect(),
            help: value.get_help().map(ToString::to_string),
            hidden: value.is_hide_set(),
        })
        .collect();

    if arg.get_id() == "section_type" && values.is_empty() {
        values = supported_section_types()
            .into_iter()
            .map(|name| ManifestPossibleValue {
                name: name.to_string(),
                aliases: Vec::new(),
                help: None,
                hidden: false,
            })
            .collect();
    }

    values
}

fn arg_kind(arg: &Arg) -> ArgKind {
    if arg.is_positional() {
        ArgKind::Positional
    } else if matches!(arg.get_action(), ArgAction::Set | ArgAction::Append) {
        ArgKind::Option
    } else {
        ArgKind::Flag
    }
}

fn supported_section_types() -> Vec<&'static str> {
    SectionType::ALL.iter().map(SectionType::as_str).collect()
}

fn examples_hook(path: &[String]) -> Option<String> {
    if path.len() == 1 {
        let name = match path[0].as_str() {
            "show" => "vtb-show",
            other => other,
        };
        let skill_path = format!("skills/{name}/SKILL.md");
        if SKILLS_DIR.get_file(format!("{name}/SKILL.md")).is_some() {
            return Some(skill_path);
        }
    }
    None
}

fn hidden_strings(all: Vec<String>, visible: &[String]) -> Vec<String> {
    let visible: BTreeSet<&str> = visible.iter().map(String::as_str).collect();
    all.into_iter()
        .filter(|alias| !visible.contains(alias.as_str()))
        .collect()
}

fn hidden_chars(all: Vec<char>, visible: &[char]) -> Vec<char> {
    let visible: BTreeSet<char> = visible.iter().copied().collect();
    all.into_iter()
        .filter(|alias| !visible.contains(alias))
        .collect()
}

fn command_lookup(manifest: &CliManifest) -> BTreeMap<Vec<String>, &ManifestCommand> {
    let mut lookup = BTreeMap::new();
    for cmd in &manifest.commands {
        collect_command_lookup(cmd, Vec::new(), &mut lookup);
    }
    lookup
}

fn flag_lookup(
    command_lookup: &BTreeMap<Vec<String>, &ManifestCommand>,
) -> BTreeMap<Vec<String>, BTreeSet<String>> {
    command_lookup
        .iter()
        .map(|(path, command)| (path.clone(), valid_flags(command)))
        .collect()
}

fn collect_command_lookup<'a>(
    cmd: &'a ManifestCommand,
    parent_variants: Vec<Vec<String>>,
    lookup: &mut BTreeMap<Vec<String>, &'a ManifestCommand>,
) {
    let parents = if parent_variants.is_empty() {
        vec![Vec::new()]
    } else {
        parent_variants
    };
    let mut names = vec![cmd.name.clone()];
    names.extend(cmd.visible_aliases.clone());
    names.extend(cmd.hidden_aliases.clone());

    let mut current_variants = Vec::new();
    for parent in parents {
        for name in &names {
            let mut path = parent.clone();
            path.push(name.clone());
            lookup.insert(path.clone(), cmd);
            current_variants.push(path);
        }
    }

    for sub in &cmd.subcommands {
        collect_command_lookup(sub, current_variants.clone(), lookup);
    }
}

fn validate_markdown_content(
    path: &Path,
    content: &str,
    command_lookup: &BTreeMap<Vec<String>, &ManifestCommand>,
    flag_lookup: &BTreeMap<Vec<String>, BTreeSet<String>>,
    issues: &mut Vec<ValidationIssue>,
) {
    let accepted_paths = command_lookup.keys().cloned().collect();
    for example in extract_vtb_examples(content, &accepted_paths) {
        if !command_lookup.contains_key(&example.command_path) {
            issues.push(ValidationIssue {
                file: path.to_path_buf(),
                message: format!(
                    "documents unknown vtb command `{}`",
                    example.command_path.join(" ")
                ),
            });
            continue;
        }

        for flag in example.flags {
            if !flag_lookup[&example.command_path].contains(&flag) {
                issues.push(ValidationIssue {
                    file: path.to_path_buf(),
                    message: format!(
                        "documents unknown flag `{}` for `vtb {}`",
                        flag,
                        example.command_path.join(" ")
                    ),
                });
            }
        }
    }
}

struct VtbExample {
    command_path: Vec<String>,
    flags: Vec<String>,
}

fn extract_vtb_command_paths(
    content: &str,
    accepted_paths: &BTreeSet<Vec<String>>,
) -> BTreeSet<Vec<String>> {
    extract_vtb_examples(content, accepted_paths)
        .into_iter()
        .map(|example| example.command_path)
        .collect()
}

fn extract_vtb_examples(content: &str, accepted_paths: &BTreeSet<Vec<String>>) -> Vec<VtbExample> {
    let mut examples = Vec::new();
    for tokens in extract_vtb_tokens(content) {
        if tokens.first().is_some_and(|token| token.starts_with("--")) {
            continue;
        }
        if let Some(command_path) = longest_command_prefix(&tokens, accepted_paths) {
            let flags = example_flags(&tokens[command_path.len()..]);
            examples.push(VtbExample {
                command_path,
                flags,
            });
        }
    }
    examples
}

fn extract_vtb_tokens(content: &str) -> Vec<Vec<String>> {
    let mut commands = Vec::new();
    let mut scan_fenced_block = true;
    let mut pending_command = String::new();

    for line in content.lines() {
        let fence = line.trim_start();
        if fence.starts_with("```") {
            flush_pending_command(&mut pending_command, &mut commands);
            if scan_fenced_block {
                let lang = fence.trim_start_matches("```").trim();
                scan_fenced_block = matches!(lang, "bash" | "sh" | "shell" | "console");
            } else {
                scan_fenced_block = true;
            }
            continue;
        }
        if !scan_fenced_block {
            continue;
        }
        let command_line = line
            .trim_start_matches(|c: char| c.is_whitespace() || c == '#' || c == '-' || c == '|')
            .trim();
        let rest = if pending_command.is_empty() {
            let Some(rest) = command_line.strip_prefix("vtb ") else {
                continue;
            };
            rest
        } else {
            line.trim()
        };
        let continued = rest.ends_with('\\');
        let rest = rest.trim_end_matches('\\').trim_end();
        if !pending_command.is_empty() {
            pending_command.push(' ');
        }
        pending_command.push_str(rest);
        if continued {
            continue;
        }
        flush_pending_command(&mut pending_command, &mut commands);
    }
    flush_pending_command(&mut pending_command, &mut commands);

    commands
}

fn flush_pending_command(pending_command: &mut String, commands: &mut Vec<Vec<String>>) {
    if !pending_command.is_empty() {
        commands.push(shell_words(pending_command));
        pending_command.clear();
    }
}

fn longest_command_prefix(
    tokens: &[String],
    accepted_paths: &BTreeSet<Vec<String>>,
) -> Option<Vec<String>> {
    let mut longest = None;
    for idx in 1..=tokens.len() {
        let prefix = tokens[..idx].to_vec();
        if accepted_paths.contains(&prefix) {
            longest = Some(prefix);
        }
    }
    longest.or_else(|| {
        tokens
            .first()
            .filter(|token| !token.starts_with('<') && !token.starts_with('-'))
            .map(|token| vec![token.clone()])
    })
}

fn shell_words(input: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote = None;

    for ch in input.chars() {
        match (quote, ch) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), c) => current.push(c),
            (None, '\'' | '"') => quote = Some(ch),
            (None, c) if c.is_whitespace() || c == '|' => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
                if c == '|' {
                    break;
                }
            }
            (None, c) => current.push(c),
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn valid_flags(command: &ManifestCommand) -> BTreeSet<String> {
    let mut flags = BTreeSet::from(["--json".to_string(), "--help".to_string(), "-h".to_string()]);
    for arg in &command.args {
        if let Some(long) = &arg.long {
            flags.insert(format!("--{long}"));
        }
        if let Some(short) = arg.short {
            flags.insert(format!("-{short}"));
        }
        for alias in &arg.visible_aliases {
            flags.insert(format!("--{alias}"));
        }
        for alias in &arg.hidden_aliases {
            flags.insert(format!("--{alias}"));
        }
        for alias in &arg.visible_short_aliases {
            flags.insert(format!("-{alias}"));
        }
        for alias in &arg.hidden_short_aliases {
            flags.insert(format!("-{alias}"));
        }
    }
    flags
}

fn example_flags(tokens: &[String]) -> Vec<String> {
    tokens
        .iter()
        .filter_map(|token| {
            if token == "--" || !token.starts_with('-') || token.starts_with("<") {
                return None;
            }
            let flag = token
                .split_once('=')
                .map_or(token.as_str(), |(flag, _)| flag);
            Some(flag.to_string())
        })
        .collect()
}

fn read_guide_pages(repo_root: &Path, issues: &mut Vec<ValidationIssue>) -> Vec<(PathBuf, String)> {
    let guide = repo_root.join("docs/vtb-guide.md");
    let content = match fs::read_to_string(&guide) {
        Ok(content) => content,
        Err(_) => {
            issues.push(ValidationIssue {
                file: guide,
                message: "required guide file is missing or unreadable".to_string(),
            });
            return Vec::new();
        }
    };

    let mut pages = vec![(guide.clone(), content.clone())];
    let mut linked_pages = linked_guide_pages(&content);
    linked_pages.sort();
    linked_pages.dedup();

    for relative in linked_pages {
        let path = repo_root.join("docs").join(&relative);
        match fs::read_to_string(&path) {
            Ok(content) => pages.push((path, content)),
            Err(_) => issues.push(ValidationIssue {
                file: guide.clone(),
                message: format!(
                    "links to missing or unreadable guide page `{}`",
                    relative.display()
                ),
            }),
        }
    }

    pages
}

fn linked_guide_pages(content: &str) -> Vec<PathBuf> {
    let mut pages = Vec::new();
    for line in content.lines() {
        let mut rest = line;
        while let Some(start) = rest.find("](vtb-guide/") {
            rest = &rest[start + 2..];
            let Some(end) = rest.find(')') else {
                break;
            };
            let target = &rest[..end];
            let target = target.split_once('#').map_or(target, |(path, _)| path);
            if target.ends_with(".md") {
                pages.push(PathBuf::from(target));
            }
            rest = &rest[end + 1..];
        }
    }
    pages
}

fn validate_guide_command_coverage<'a>(
    path: &Path,
    contents: impl IntoIterator<Item = &'a str>,
    manifest: &CliManifest,
    command_lookup: &BTreeMap<Vec<String>, &ManifestCommand>,
    issues: &mut Vec<ValidationIssue>,
) {
    let accepted_paths = command_lookup.keys().cloned().collect();
    let mut documented = BTreeSet::new();
    for content in contents {
        documented.extend(extract_vtb_command_paths(content, &accepted_paths));
    }
    let documented_children = documented.clone();
    for path in documented_children {
        for idx in 1..path.len() {
            documented.insert(path[..idx].to_vec());
        }
    }

    for required in canonical_visible_paths(manifest) {
        if !documented.contains(&required) {
            issues.push(ValidationIssue {
                file: path.to_path_buf(),
                message: format!("omits vtb command `{}`", required.join(" ")),
            });
        }
    }
}

fn canonical_visible_paths(manifest: &CliManifest) -> Vec<Vec<String>> {
    let mut paths = Vec::new();
    for cmd in &manifest.commands {
        collect_canonical_visible_paths(cmd, &mut paths);
    }
    paths
}

fn collect_canonical_visible_paths(cmd: &ManifestCommand, paths: &mut Vec<Vec<String>>) {
    if !cmd.hidden {
        paths.push(cmd.path.clone());
    }
    for sub in &cmd.subcommands {
        collect_canonical_visible_paths(sub, paths);
    }
}

fn validate_section_types_in_content(
    path: &Path,
    content: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    let supported: BTreeSet<&str> = supported_section_types().into_iter().collect();
    for documented in documented_section_types(content) {
        if documented.starts_with('<') {
            continue;
        }
        if !supported.contains(documented.as_str()) {
            issues.push(ValidationIssue {
                file: path.to_path_buf(),
                message: format!(
                    "documents unsupported section type `{}`; supported types are: {}",
                    documented,
                    supported.iter().copied().collect::<Vec<_>>().join(", ")
                ),
            });
        }
    }
}

fn documented_section_types(content: &str) -> BTreeSet<String> {
    let mut types = BTreeSet::new();
    let mut in_section_table = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "### Section Types" {
            in_section_table = true;
            continue;
        }
        if in_section_table && trimmed.starts_with("### ") {
            in_section_table = false;
        }
        if in_section_table
            && trimmed.starts_with('|')
            && let Some(value) = first_backticked_value(trimmed)
        {
            types.insert(value);
        }

        if let Some(value) = section_command_type(trimmed) {
            types.insert(value);
        }
    }

    types
}

fn first_backticked_value(line: &str) -> Option<String> {
    let start = line.find('`')?;
    let rest = &line[start + 1..];
    let end = rest.find('`')?;
    Some(rest[..end].to_string())
}

fn section_command_type(line: &str) -> Option<String> {
    let rest = line.strip_prefix("vtb ")?;
    let tokens = shell_words(rest);
    match tokens.as_slice() {
        [command, _id, section_type, ..] if command == "section" => Some(section_type.clone()),
        [command, _id, flag, section_type, ..] if command == "sections" && flag == "--type" => {
            Some(section_type.clone())
        }
        [command, _id, section_type, ..] if command == "unsection" && section_type != "--index" => {
            Some(section_type.clone())
        }
        [command, _id, flag, section_type, ..]
            if command == "update" && (flag == "--edit-section" || flag == "--remove-section") =>
        {
            Some(section_type.clone())
        }
        _ => None,
    }
}

fn skill_docs(root: &Path) -> Vec<PathBuf> {
    let mut docs = Vec::new();
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path().join("SKILL.md");
            if path.exists() {
                docs.push(path);
            }
        }
    }
    docs.sort();
    docs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_paths(manifest: &CliManifest) -> BTreeSet<Vec<String>> {
        let mut paths = BTreeSet::new();
        fn visit(cmd: &ManifestCommand, paths: &mut BTreeSet<Vec<String>>) {
            paths.insert(cmd.path.clone());
            for sub in &cmd.subcommands {
                visit(sub, paths);
            }
        }
        for cmd in &manifest.commands {
            visit(cmd, &mut paths);
        }
        paths
    }

    fn temp_repo(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("vertebrae-manifest-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("docs/vtb-guide")).expect("create temp docs dir");
        root
    }

    #[test]
    fn manifest_contains_visible_top_level_and_nested_commands() {
        let manifest = build_manifest();
        let paths = command_paths(&manifest);
        for expected in [
            vec!["add"],
            vec!["archive"],
            vec!["blockers"],
            vec!["criterion-ref"],
            vec!["daemon"],
            vec!["daemon", "install"],
            vec!["daemon", "uninstall"],
            vec!["daemon", "status"],
            vec!["execution"],
            vec!["execution", "create"],
            vec!["execution", "list"],
            vec!["execution", "show"],
            vec!["execution", "update"],
            vec!["execution", "log"],
            vec!["manifest"],
            vec!["manifest", "print"],
            vec!["manifest", "validate-docs"],
            vec!["step"],
            vec!["step", "add"],
            vec!["step", "list"],
            vec!["step", "show"],
            vec!["step", "update"],
            vec!["step", "delete"],
            vec!["workflow"],
            vec!["workflow", "add"],
            vec!["workflow", "list"],
            vec!["workflow", "show"],
            vec!["workflow", "update"],
            vec!["workflow", "delete"],
            vec!["workflow", "assign"],
            vec!["workflow", "unassign"],
            vec!["workflow", "transition"],
            vec!["workflow", "transition", "add"],
            vec!["workflow", "transition", "delete"],
            vec!["workflow", "transition", "list"],
        ] {
            let expected = expected.into_iter().map(String::from).collect::<Vec<_>>();
            assert!(
                paths.contains(&expected),
                "manifest missing command path `{}`",
                expected.join(" ")
            );
        }
    }

    #[test]
    fn manifest_exposes_aliases_defaults_and_value_enums() {
        let manifest = build_manifest();
        let start_taskrun = manifest
            .commands
            .iter()
            .find(|cmd| cmd.name == "start-taskrun")
            .expect("start-taskrun command");
        assert_eq!(start_taskrun.visible_aliases, vec!["run-workflow"]);

        let stop_taskrun = manifest
            .commands
            .iter()
            .find(|cmd| cmd.name == "stop-taskrun")
            .expect("stop-taskrun command");
        assert_eq!(stop_taskrun.visible_aliases, vec!["stop", "stop-workflow"]);

        let step_add = manifest
            .commands
            .iter()
            .find(|cmd| cmd.name == "step")
            .and_then(|cmd| cmd.subcommands.iter().find(|sub| sub.name == "add"))
            .expect("step add command");
        let step_type = step_add
            .args
            .iter()
            .find(|arg| arg.long.as_deref() == Some("step-type"))
            .expect("step-type arg");
        let values: Vec<&str> = step_type
            .possible_values
            .iter()
            .map(|value| value.name.as_str())
            .collect();
        assert_eq!(
            values,
            vec![
                "execute",
                "evaluate",
                "route",
                "wait_children",
                "human_input"
            ]
        );
        assert_eq!(step_type.default_values, vec!["execute"]);
    }

    #[test]
    fn manifest_locally_models_supported_section_types() {
        let manifest = build_manifest();
        assert_eq!(
            manifest.locally_modelled.section_types,
            vec![
                "goal",
                "context",
                "current_behavior",
                "desired_behavior",
                "checklist_item",
                "testing_criterion",
                "anti_pattern",
                "failure_test",
                "constraint"
            ]
        );

        let section = manifest
            .commands
            .iter()
            .find(|cmd| cmd.name == "section")
            .expect("section command");
        let values: Vec<&str> = section.args[1]
            .possible_values
            .iter()
            .map(|value| value.name.as_str())
            .collect();
        assert!(values.contains(&"checklist_item"));
        assert!(!values.contains(&"step"));
    }

    #[test]
    fn validator_catches_stale_step_section_type_docs() {
        let content = r#"
### Section Types
| Type | Purpose |
|------|---------|
| `goal` | Goal |
| `step` | Ordered implementation steps |

```bash
vtb section <id> step "Do the thing"
```
"#;
        let types = documented_section_types(content);
        assert!(types.contains("step"));

        let supported: BTreeSet<&str> = supported_section_types().into_iter().collect();
        let unsupported: Vec<&String> = types
            .iter()
            .filter(|section_type| !supported.contains(section_type.as_str()))
            .collect();
        assert_eq!(unsupported, vec![&"step".to_string()]);
    }

    #[test]
    fn validator_reports_missing_repo_root() {
        let report = validate_docs(Path::new("/tmp/vertebrae-manifest-missing-root"));
        assert!(!report.is_ok());
        assert!(
            report
                .render()
                .contains("repository root does not exist or is not a directory")
        );
    }

    #[test]
    fn guide_reader_loads_entrypoint_and_linked_split_pages() {
        let root = temp_repo("split-pages");
        fs::write(
            root.join("docs/vtb-guide.md"),
            "[Tasks](vtb-guide/tasks.md)\n[Steps](vtb-guide/steps.md#provider-selection)\n",
        )
        .expect("write guide entrypoint");
        fs::write(root.join("docs/vtb-guide/tasks.md"), "vtb add \"Title\"\n")
            .expect("write tasks page");
        fs::write(root.join("docs/vtb-guide/steps.md"), "vtb step list\n")
            .expect("write steps page");

        let mut issues = Vec::new();
        let pages = read_guide_pages(&root, &mut issues);

        assert!(issues.is_empty());
        assert_eq!(pages.len(), 3);
        assert!(
            pages
                .iter()
                .any(|(path, _)| path.ends_with("docs/vtb-guide/tasks.md"))
        );
        assert!(
            pages
                .iter()
                .any(|(path, _)| path.ends_with("docs/vtb-guide/steps.md"))
        );
        fs::remove_dir_all(root).expect("remove temp repo");
    }

    #[test]
    fn guide_reader_reports_missing_linked_split_page() {
        let root = temp_repo("missing-split-page");
        fs::write(
            root.join("docs/vtb-guide.md"),
            "[Missing](vtb-guide/missing.md)\n",
        )
        .expect("write guide entrypoint");

        let mut issues = Vec::new();
        let pages = read_guide_pages(&root, &mut issues);

        assert_eq!(pages.len(), 1);
        assert_eq!(issues.len(), 1);
        assert!(
            issues[0]
                .message
                .contains("links to missing or unreadable guide page `vtb-guide/missing.md`")
        );
        fs::remove_dir_all(root).expect("remove temp repo");
    }

    #[test]
    fn extracts_flags_from_multiline_examples() {
        let accepted_paths = [vec!["list".to_string()]].into_iter().collect();
        let content = r#"
```bash
vtb list \
  --level ticket \
  --status todo
```
"#;
        let examples = extract_vtb_examples(content, &accepted_paths);
        assert_eq!(examples.len(), 1);
        assert_eq!(examples[0].command_path, vec!["list"]);
        assert_eq!(examples[0].flags, vec!["--level", "--status"]);
    }

    #[test]
    fn section_type_validation_ignores_placeholders() {
        let content = r#"
```bash
vtb section <id> <type> "Content"
vtb sections <id> --type checklist_item
```
"#;
        assert_eq!(
            documented_section_types(content),
            ["<type>".to_string(), "checklist_item".to_string()]
                .into_iter()
                .collect()
        );

        let mut issues = Vec::new();
        validate_section_types_in_content(
            Path::new("skills/section/SKILL.md"),
            content,
            &mut issues,
        );
        assert!(issues.is_empty());
    }
}
