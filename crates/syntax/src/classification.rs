fn has(words: &str, value: &str) -> bool {
    words.split_whitespace().any(|word| word == value)
}

fn option<'a>(options: &'a str, arg: &str) -> Option<&'a str> {
    options.split_whitespace().find(|opt| {
        arg.strip_prefix(opt)
            .is_some_and(|tail| tail.is_empty() || tail.starts_with('=') || opt.len() == 2)
    })
}

fn command<'a>(
    mut args: &'a [Option<String>],
    values: &str,
    flags: &str,
) -> Option<(&'a str, &'a [Option<String>])> {
    while let Some((arg, rest)) = args.split_first() {
        let arg = arg.as_deref()?;
        args = rest;
        if !arg.starts_with('-') {
            return Some((arg, rest));
        }
        match option(values, arg) {
            Some(opt) if opt == arg => {
                let (value, rest) = args.split_first()?;
                value.as_ref()?;
                args = rest;
            }
            Some(_) => {}
            None if has(flags, arg) => {}
            None => return None,
        }
    }
    None
}

fn any(args: &[Option<String>], words: &str) -> bool {
    args.iter().flatten().any(|arg| has(words, arg))
}

fn github_api(mut args: &[Option<String>]) -> Option<&'static str> {
    let mut method = None;
    let mut endpoint = None;
    let mut query = None;
    let mut fields = false;
    while let Some((arg, rest)) = args.split_first() {
        let arg = arg.as_deref()?;
        args = rest;
        if let Some(opt) = option("-X --method -f -F --field --raw-field --input -H --header -q --jq --template --cache --hostname --preview", arg) {
            let value = if opt == arg {
                let (value, rest) = args.split_first()?;
                args = rest;
                value.as_deref()?
            } else {
                arg[opt.len()..].strip_prefix('=').unwrap_or(&arg[opt.len()..])
            };
            if has("-X --method", opt) {
                method = Some(value.to_uppercase());
            }
            fields |= has("-f -F --field --raw-field --input", opt);
            if has("-f -F --field --raw-field", opt) {
                if let Some(value) = value.strip_prefix("query=") {
                    query = Some(value.trim_start());
                }
            }
        } else if !has("--paginate --slurp --silent --include -i --verbose", arg)
            && (arg.starts_with('-') || endpoint.replace(arg).is_some())
        {
            return None;
        }
    }
    if endpoint.filter(|endpoint| !endpoint.is_empty())? == "graphql" {
        let query = query?;
        let word = query
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .next()?;
        return match word {
            "query" => Some("GitHub inspection"),
            "mutation" => Some("GitHub changes"),
            _ if query.starts_with('{') => Some("GitHub inspection"),
            _ => None,
        };
    }
    match method
        .as_deref()
        .unwrap_or(if fields { "POST" } else { "GET" })
    {
        "" | "POST" | "PUT" | "PATCH" | "DELETE" => Some("GitHub changes"),
        "GET" | "HEAD" | "OPTIONS" => Some("GitHub inspection"),
        _ => None,
    }
}

fn git(name: &str, args: &[Option<String>]) -> Option<&'static str> {
    let parsed = match name {
        "git" => command(
            args,
            "-C -c --git-dir --work-tree --namespace --config-env",
            "--no-pager --paginate -P -p --bare --no-optional-locks --literal-pathspecs",
        ),
        "gh" => command(args, "-R --repo --hostname", ""),
        _ => return None,
    };
    let Some((verb, rest)) = parsed else {
        return any(args, "--help -h --version").then_some("documentation");
    };
    if verb == "help" || any(rest, "--help -h") {
        return Some("documentation");
    }
    if name == "gh" {
        if verb == "api" {
            return github_api(rest);
        }
        if has("search status browse", verb) {
            return Some("GitHub inspection");
        }
        let (sub, _) = command(rest, "-R --repo --hostname", "")?;
        if !has("pr issue run workflow release repo gist project discussion cache secret variable label ruleset auth config", verb) {
            return None;
        }
        if has("list view status diff checks watch download get", sub) {
            return Some("GitHub inspection");
        }
        if (verb, sub) == ("pr", "checkout") {
            return Some("Git changes");
        }
        return has("create edit delete close reopen merge review comment ready lock unlock transfer pin unpin rerun cancel run enable disable upload set fork archive unarchive sync rename", sub).then_some("GitHub changes");
    }
    let first = rest.first().and_then(Option::as_deref).unwrap_or_default();
    let label = match verb {
        "status" | "diff" | "log" | "show" | "ls-files" | "ls-tree" | "rev-parse" | "rev-list"
        | "cat-file" | "show-ref" | "describe" | "blame" | "shortlog" | "range-diff"
        | "check-ignore" | "grep" | "fsck" => "Git inspection",
        "fetch" | "push" | "pull" | "clone" => "Git synchronization",
        "worktree" if first == "list" => "Git inspection",
        "worktree" if has("add remove prune move lock unlock repair", first) => {
            "environment management"
        }
        "branch" | "tag" => {
            if rest.iter().any(Option::is_none) {
                return None;
            }
            if (verb == "tag" && any(rest, "-a")) || rest.iter().flatten().any(|arg| {
                option("-d -D --delete -m -M --move -c -C --copy -s -f --force --set-upstream-to --unset-upstream --edit-description -u", arg).is_some()
            }) {
                "Git changes"
            } else if any(rest, "--list -l --show-current --contains --merged --no-merged")
                || rest.iter().flatten().any(|arg| arg.starts_with("--contains=") || arg.starts_with("--format="))
                || rest.iter().flatten().all(|arg| arg.starts_with('-')) {
                "Git inspection"
            } else {
                "Git changes"
            }
        }
        "remote"
            if rest
                .iter()
                .all(|arg| matches!(arg.as_deref(), Some("-v" | "--verbose")))
                || has("get-url show", first) =>
        {
            "Git inspection"
        }
        "remote" if has("add remove rename set-url set-head prune update", first) => "Git changes",
        "stash" if has("list show", first) => "Git inspection",
        "stash" => "Git changes",
        "config" if any(rest, "--get --get-all --get-regexp --list -l get list") => {
            "Git inspection"
        }
        "add" | "commit" | "merge" | "rebase" | "reset" | "restore" | "checkout" | "switch"
        | "cherry-pick" | "revert" | "apply" | "am" | "rm" | "mv" | "clean" | "update-ref"
        | "init" => "Git changes",
        _ => return None,
    };
    Some(label)
}

fn development(executable: &str, name: &str, args: &[Option<String>]) -> Option<&'static str> {
    if ["scripts/validate", "scripts/validate.sh"]
        .iter()
        .any(|suffix| {
            executable
                .strip_suffix(suffix)
                .is_some_and(|prefix| prefix.is_empty() || prefix.ends_with('/'))
        })
    {
        return Some("checks");
    }
    if !has("cargo npm pnpm yarn bun mix", name) {
        return None;
    }
    let (verb, rest) = command(
        args,
        "--prefix --cwd --dir -C --workspace -w",
        "--silent -s --offline --frozen-lockfile",
    )?;
    let task = if has("run run-script", verb) {
        rest.first()?.as_deref()?
    } else {
        verb
    };
    if task == "build" || (name, task) == ("mix", "compile") {
        return Some("builds");
    }
    has(
        "test check fmt clippy lint typecheck format validate validation",
        task,
    )
    .then_some("checks")
}

pub(crate) enum CommandActivity {
    Known(Option<&'static str>),
    Unknown,
}

pub(crate) fn classify_command(
    executable: &str,
    args: &[Option<String>],
    pipeline: bool,
) -> CommandActivity {
    use CommandActivity::{Known, Unknown};
    if has("rg grep find ls fd", executable) {
        return Known((!pipeline).then_some("source search"));
    }
    let name = executable.rsplit('/').next().unwrap_or_default();
    if let Some(label) = git(name, args) {
        return Known(Some(label));
    }
    if any(args, "--help -h") {
        return Known(Some("documentation"));
    }
    if let Some(label) = development(executable, name, args) {
        return Known(Some(label));
    }
    match executable {
        "vtb" => Known(Some("task management")),
        "curl" | "wget" => Known(Some(
            if args.iter().flatten().any(|arg| {
                arg.strip_prefix("http://")
                    .or_else(|| arg.strip_prefix("https://"))
                    .is_some_and(|host| {
                        ["localhost", "127.0.0.1"].iter().any(|local| {
                            host.strip_prefix(local)
                                .is_some_and(|tail| tail.is_empty() || tail.starts_with([':', '/']))
                        })
                    })
            }) {
                "environment management"
            } else {
                "web requests"
            },
        )),
        _ if pipeline || has("pwd echo printf true false wc sort uniq cut", executable) => {
            Known(None)
        }
        _ => Unknown,
    }
}

pub(crate) fn classify_tool(qualified: &str, name: &str) -> &'static [&'static str] {
    if name.ends_with("web__run") {
        return &["web requests"];
    }
    match name {
        "Grep" | "Glob" => return &["source search"],
        "spawn_agent"
        | "send_message"
        | "wait_agent"
        | "followup_task"
        | "request_user_input_async"
        | "Agent"
        | "ListAgents"
        | "SendMessage"
        | "AskUserQuestion" => return &["coordination"],
        "write_stdin" | "sleep" | "wait" | "Monitor" | "TaskStop" | "EnterWorktree"
        | "ExitWorktree" => return &["environment management"],
        "view_image" => return &["visual inspection"],
        _ => {}
    }
    if let Some(gui) = name
        .strip_prefix("mcp__hammerspoon-gui__gui_")
        .or_else(|| name.strip_prefix("mcp__hammerspoon_gui__gui_"))
    {
        match gui {
            "screenshot" | "screenshot_full" | "screenshot_window" | "ui_elements"
            | "ui_elements_app" | "window_list" | "window_find" | "window_focused"
            | "mouse_position" => return &["visual inspection"],
            "click_and_screenshot" => return &["UI interaction", "visual inspection"],
            "click" | "click_screen" | "right_click" | "type" | "key_press" | "window_focus"
            | "move_mouse" => return &["UI interaction"],
            _ => {}
        }
    }
    let qualified = qualified.to_ascii_lowercase();
    if qualified.starts_with("tidewave.")
        || qualified
            .strip_prefix("mcp__")
            .and_then(|name| name.split_once("tidewave"))
            .is_some_and(|(_, tail)| tail.contains("__"))
    {
        return match name.rsplit("__").next().unwrap_or_default() {
            "get_logs" | "get_models" | "get_schemas" | "get_ecto_schemas"
            | "get_ash_resources" => &["runtime inspection"],
            "get_docs" => &["documentation"],
            "get_source_location" => &["source search"],
            _ => &[],
        };
    }
    &[]
}

#[cfg(test)]
mod tests {
    use super::git;
    use serde::Deserialize;

    #[derive(Debug, Deserialize)]
    struct GitCase {
        name: String,
        args: Vec<Option<String>>,
        expected: Option<String>,
    }

    #[test]
    fn matches_the_previous_git_and_github_rule_matrix() {
        for line in include_str!("../tests/fixtures/git-activity.jsonl").lines() {
            let case: GitCase = serde_json::from_str(line).unwrap();
            assert_eq!(
                git(&case.name, &case.args),
                case.expected.as_deref(),
                "{case:?}"
            );
        }
    }
}
