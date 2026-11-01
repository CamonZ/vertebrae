import categories from "./categories.json";

export const activityNames = new Map(
  categories.map(({ label, title }) => [label, title])
);
const includes = (words: string, value?: string) =>
  value !== undefined && words.split(" ").includes(value);

/** Consume known option values before locating a command; never skip dynamic argv. */
function command(args: (string | undefined)[], values: string, flags = "") {
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) return;
    if (!arg.startsWith("-")) return { name: arg, args: args.slice(i + 1) };
    const option = values
      .split(" ")
      .find(
        (v) =>
          v &&
          (arg === v ||
            arg.startsWith(`${v}=`) ||
            (v.length === 2 && arg.startsWith(v)))
      );
    if (option) {
      if (arg === option && args[++i] === undefined) return;
    } else if (!includes(flags, arg)) return;
  }
}

function githubApi(args: (string | undefined)[]): string | undefined {
  let method: string | undefined,
    endpoint: string | undefined,
    query: string | undefined;
  let fields = false;
  const valueOptions =
    "-X --method -f -F --field --raw-field --input -H --header -q --jq --template --cache --hostname --preview".split(
      " "
    );
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) return;
    const option = valueOptions.find(
      (v) =>
        arg === v ||
        arg.startsWith(`${v}=`) ||
        (v.length === 2 && arg.startsWith(v))
    );
    if (option) {
      const value =
        arg === option ? args[++i] : arg.slice(option.length).replace(/^=/, "");
      if (value === undefined) return;
      if (includes("-X --method", option)) method = value.toUpperCase();
      if (includes("-f -F --field --raw-field --input", option)) fields = true;
      if (
        includes("-f -F --field --raw-field", option) &&
        value.startsWith("query=")
      )
        query = value;
    } else if (
      includes("--paginate --slurp --silent --include -i --verbose", arg)
    )
      continue;
    else if (arg.startsWith("-") || endpoint !== undefined) return;
    else endpoint = arg;
  }
  if (!endpoint) return;
  if (endpoint === "graphql") {
    if (!query) return;
    if (/^query=\s*(?:query\b|\{)/.test(query)) return "GitHub inspection";
    return /^query=\s*mutation\b/.test(query) ? "GitHub changes" : undefined;
  }
  if (method && !includes("GET HEAD POST PUT PATCH DELETE OPTIONS", method))
    return;
  return includes("GET HEAD OPTIONS", method ?? (fields ? "POST" : "GET"))
    ? "GitHub inspection"
    : "GitHub changes";
}

export function gitActivity(
  executable: string,
  argv: (string | undefined)[]
): string | undefined {
  const name = executable.split("/").pop();
  if (name !== "git" && name !== "gh") return;
  const cmd =
    name === "git"
      ? command(
          argv,
          "-C -c --git-dir --work-tree --namespace --config-env",
          "--no-pager --paginate -P -p --bare --no-optional-locks --literal-pathspecs"
        )
      : command(argv, "-R --repo --hostname");
  if (!cmd)
    return argv.some((a) => includes("--help -h --version", a))
      ? "documentation"
      : undefined;
  const { name: verb, args } = cmd;
  if (verb === "help" || args.some((a) => includes("--help -h", a)))
    return "documentation";
  if (name === "gh") {
    if (verb === "api") return githubApi(args);
    if (includes("search status browse", verb)) return "GitHub inspection";
    const sub = command(args, "-R --repo --hostname");
    if (
      !sub ||
      !includes(
        "pr issue run workflow release repo gist project discussion cache secret variable label ruleset auth config",
        verb
      )
    )
      return;
    if (includes("list view status diff checks watch download get", sub.name))
      return "GitHub inspection";
    if (verb === "pr" && sub.name === "checkout") return "Git changes";
    return includes(
      "create edit delete close reopen merge review comment ready lock unlock transfer pin unpin rerun cancel run enable disable upload set fork archive unarchive sync rename",
      sub.name
    )
      ? "GitHub changes"
      : undefined;
  }
  if (
    includes(
      "status diff log show ls-files ls-tree rev-parse rev-list cat-file show-ref describe blame shortlog range-diff check-ignore grep fsck",
      verb
    )
  )
    return "Git inspection";
  if (includes("fetch push pull clone", verb)) return "Git synchronization";
  if (verb === "worktree")
    return args[0] === "list"
      ? "Git inspection"
      : includes("add remove prune move lock unlock repair", args[0])
        ? "environment management"
        : undefined;
  if (verb === "branch" || verb === "tag") {
    if (args.includes(undefined)) return;
    const mutations =
      "-d -D --delete -m -M --move -c -C --copy -s -f --force --set-upstream-to --unset-upstream --edit-description -u".split(
        " "
      );
    if (
      (verb === "tag" && args.includes("-a")) ||
      args.some((a) =>
        mutations.some(
          (option) =>
            a === option ||
            a?.startsWith(`${option}=`) ||
            (option.length === 2 && a?.startsWith(option))
        )
      )
    )
      return "Git changes";
    const listing = args.some(
      (a) =>
        includes(
          "--list -l --show-current --contains --merged --no-merged",
          a
        ) ||
        a?.startsWith("--contains=") ||
        a?.startsWith("--format=")
    );
    return listing || args.every((a) => a?.startsWith("-"))
      ? "Git inspection"
      : "Git changes";
  }
  if (verb === "remote")
    return !args.length ||
      args.every((a) => includes("-v --verbose", a)) ||
      includes("get-url show", args[0])
      ? "Git inspection"
      : includes("add remove rename set-url set-head prune update", args[0])
        ? "Git changes"
        : undefined;
  if (verb === "stash")
    return includes("list show", args[0]) ? "Git inspection" : "Git changes";
  if (verb === "config")
    return args.some((a) =>
      includes("--get --get-all --get-regexp --list -l get list", a)
    )
      ? "Git inspection"
      : undefined;
  return includes(
    "add commit merge rebase reset restore checkout switch cherry-pick revert apply am rm mv clean update-ref init",
    verb
  )
    ? "Git changes"
    : undefined;
}

export function developmentActivity(
  executable: string,
  args: (string | undefined)[]
): string | undefined {
  if (/(?:^|\/)scripts\/validate(?:\.sh)?$/.test(executable)) return "checks";
  const name = executable.split("/").pop();
  if (!includes("cargo npm pnpm yarn bun mix", name)) return;
  const cmd = command(
    args,
    "--prefix --cwd --dir -C --workspace -w",
    "--silent -s --offline --frozen-lockfile"
  );
  if (!cmd) return;
  const task = includes("run run-script", cmd.name) ? cmd.args[0] : cmd.name;
  if (task === "build" || (name === "mix" && task === "compile"))
    return "builds";
  return includes(
    "test check fmt clippy lint typecheck format validate validation",
    task
  )
    ? "checks"
    : undefined;
}

/** Structural cases (wrappers, redirects, file operands and Python) stay in the parser. */
export function classifyCommand(
  name: string,
  args: (string | undefined)[],
  pipelineFilter: boolean
): string | null | undefined {
  if (includes("rg grep find ls fd", name))
    return pipelineFilter ? null : "source search";
  const git = gitActivity(name, args);
  if (git) return git;
  if (args.includes("--help") || args.includes("-h")) return "documentation";
  const task = developmentActivity(name, args);
  if (task) return task;
  if (name === "vtb") return "task management";
  if (includes("curl wget", name))
    return args.some((arg) =>
      /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(arg ?? "")
    )
      ? "environment management"
      : "web requests";
  if (
    pipelineFilter ||
    includes("pwd echo printf true false wc sort uniq cut", name)
  )
    return null;
}

/** Intent known from the tool contract; evaluators and SQL require input judgments. */
export function classifyTool(qualifiedName: string): string[] | undefined {
  const name = qualifiedName.split(".").at(-1) ?? qualifiedName;
  if (["Grep", "Glob"].includes(name)) return ["source search"];
  if (name.endsWith("web__run")) return ["web requests"];
  if (
    [
      "spawn_agent",
      "send_message",
      "wait_agent",
      "followup_task",
      "request_user_input_async",
      "Agent",
      "ListAgents",
      "SendMessage",
      "AskUserQuestion",
    ].includes(name)
  )
    return ["coordination"];
  if (
    [
      "write_stdin",
      "sleep",
      "wait",
      "Monitor",
      "TaskStop",
      "EnterWorktree",
      "ExitWorktree",
    ].includes(name)
  )
    return ["environment management"];
  if (name === "view_image") return ["visual inspection"];
  const gui = name.match(/^mcp__hammerspoon[-_]gui__gui_(.+)$/)?.[1];
  if (
    gui &&
    [
      "screenshot",
      "screenshot_full",
      "screenshot_window",
      "ui_elements",
      "ui_elements_app",
      "window_list",
      "window_find",
      "window_focused",
      "mouse_position",
    ].includes(gui)
  )
    return ["visual inspection"];
  if (gui === "click_and_screenshot")
    return ["UI interaction", "visual inspection"];
  if (
    gui &&
    [
      "click",
      "click_screen",
      "right_click",
      "type",
      "key_press",
      "window_focus",
      "move_mouse",
    ].includes(gui)
  )
    return ["UI interaction"];
  if (/(?:^mcp__.*tidewave.*__|^tidewave\.)/i.test(qualifiedName)) {
    const operation = name.split("__").at(-1);
    if (
      [
        "get_logs",
        "get_models",
        "get_schemas",
        "get_ecto_schemas",
        "get_ash_resources",
      ].includes(operation ?? "")
    )
      return ["runtime inspection"];
    if (operation === "get_docs") return ["documentation"];
    if (operation === "get_source_location") return ["source search"];
  }
}
