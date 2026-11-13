# Explain code: a PR or a part of the system

A flow diagram answers one question about real code, with evidence a reader
can open: what an open PR will change, what a merged PR did, or how part of
the system works today. These principles matter more than any template.

## Principles

- **Code before prose.** Read the code you are explaining. A PR description
  or design doc says what was intended; the code says what happens.
- **One question, one input.** Pick the question a reader would ask ("what
  breaks if…?", "when does X happen?", "why does Y survive Z?") and the one
  representative input that answers it. Leave out everything else.
- **Inventory first.** Before writing YAML, list the stations (where work
  stops or a decision is made), the cards, what each station does in order,
  what runs at the same time (`with: true`), and what ends the story: a
  result, a rejection, or a stored record.
- **Kind is the mechanism; label is the code.** Choose each part by its job
  in the [reference](../../machine-diagrams-reference.md) and label it with
  the symbol it stands for. For Vertebrae workflows the part comes from
  `step_type`, never the step name, and colour from TaskRun or step status.
- **Compose, don't invent.** When no single part fits, connect existing
  parts or say so in a note. Never add a lookalike kind.
- **Always show a failure path.** Run a second input through the failing
  station's own failure verb or outcome (a guard's `deny`, `worker.fail`,
  a transform's `outcome: error`) and show what stays unchanged.
- **Honest evidence.** Mark an attachment `verified` only if you read the
  claim in the code at the cited lines (`ref` with `line`, `endLine`,
  `symbol`). Everything else is `inferred`: descriptions, tests you did not
  run, timings. Keep `source: scenario` unless you have a recorded trace.

## By subject

- **Open PR (review).** Read the diff (`gh pr diff N`) and the head checked
  out in a worktree, so refs match what you read. Cite changed lines with
  `diff` attachments carrying `base` and `head` SHAs; branch lines move with
  every push. Use a shared [Before/After](before-after.md) spec, and aim the
  failure path at the risk a reviewer would worry about. State unverified
  behaviour as an inferred note, a question for the author, not a fact.
  Re-check evidence after new pushes.
- **Merged PR.** The same, read at the merge commit; refs to the default
  branch stay valid until the code moves.
- **Design options or competing PRs.** One change is Before/After; two or
  more alternatives are [named arrangements](options.md) over the current
  machine, so each option is marked against what exists today and the
  reader compares outcomes on the same story. Cite each option's own diff.
- **Part of the system.** No diff: start at an entry point (a command,
  handler or event), follow one input to its observable end, and cite the
  current default branch. Use one arrangement; put deeper mechanisms behind
  a [drill-down](drill.md) instead of widening the top level.

## Validate until it passes

Save the body to a file and run `vtb flow validate explanation.flow.yaml`.
Each error prints as `path: message`, for example `story[0].steps[5].card:
card "first" is a data; rail "answer" carries result`; fix the named field
and rerun. Exit 0 means it parses and compiles exactly as the chat viewer
would; `--json` returns `{valid, format, errors}`. It needs no project or
backend, and it does not check evidence: reopen each cited range before
delivering. Then replay the story and check each caption matches what the
diagram shows. Save to a ticket only when asked; see [artifacts](../artifacts.md).

[Recipe index](../../machine-diagrams-recipes.md).
