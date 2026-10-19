# Resolution

Purpose: exercise the completed recipe end to end.
Use this when: manually testing CLI resolution, GUI loop-back, or schema errors.

## Start a run
With consent, create and run a task on the workflow:
```sh
task=$(vtb add "Demo question" --level ticket --workflow "$workflow" | vtb_id)
vtb start-taskrun "$task"
```

## Resolve from the CLI
When `vtb show "$task"` reports the gate waiting, copy the current waiting
StepExecution ID and submit:
```sh
vtb artifact add answer.json --subject-type step_execution \
  --subject-id <waiting-execution> --logical-name answer \
  --body '{"outcome":"resolved","answer":"<your answer>","rationale":"<why this answer is valid>"}'
```

An inadequate evaluation loops back; the next artifact must target the new
waiting execution. A body violating the schema fails with its JSON path, such
as `#/answer`, and leaves the current gate waiting.

## Resolve from the GUI
Assign the workflow to a visible task and start its run. Select the waiting
gate and choose Resolve. The same chat remains bound across loop-back: after
an inadequate verdict it receives one evaluation turn carrying the reasons and
shows `Rejected · attempt 2`; after an adequate verdict it shows `Gate closed`.

## Related
[human_input](../../workflows/steps/human_input.md) · [Authoring commands](authoring.md) · [Route decisions](routes.md)
