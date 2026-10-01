# Steps

Each step's type decides who handles it: the daemon (AI work or Rhai transformations) or the backend (control flow).

- [Step types](step-types.md): pick a type by intent; comparison of all eight.
  Load when: "which step type should I use", explaining what a step does.
- [Harness](harness.md): the `claude`/`codex`/`typesafe` runtime selector for inference steps.
  Load when: `--harness`, "run it on Codex/Claude/TypeSafe", `--harness is required`, harness errors at save or run time.
- [llm_inference](llm_inference/index.md): an agent (`claude` or `codex` harness) does open-ended work.
  Load when: prompts, agent config, model/speed tier, output schemas, tool restrictions.
- [structured_inference](structured_inference/index.md): the `typesafe` harness answers fixed questions.
  Load when: questions, noul/choice/score, confidence, probabilities, Jev/TypeSafe, state.
- [execute](execute/index.md): pure Rhai transformations of resolved JSON, without a provider harness.
  Load when: execute, Rhai, --script, deterministic calculations, typed input/output, script limits or cancellation, execute authoring.
- [route](route/index.md): deterministic branching on prior output, task level, tags, visit count.
  Load when: route_config, rules, default, handoff, loops, `route_ambiguous_match`, `route_no_match`.
- [wait_children](wait_children.md): run a task's children and wait for them.
  Load when: parent/child orchestration, child TaskRuns, `wait_children_status`, a parent stuck waiting.
- [stop](stop.md): end the current TaskRun without completing the task.
  Load when: run boundaries, "pause here", resuming in a later run.
- [finish](finish.md): complete the task.
  Load when: terminal steps, task completion, dependents starting after completion.
- [human_input](human_input.md): a human gate (limited today).
  Load when: approvals, manual review steps.
