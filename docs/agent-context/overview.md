# Overview

Purpose: explain what Vertebrae is and how its parts fit together.
Use this when: the user asks what the app does, or you need a shared vocabulary.

## What you can do
Describe the system, name the component that owns a behaviour, and pick the
right surface (CLI, GUI, chat) for a request.

## How it works
- The **backend** owns durable state: projects, tasks, workflows, steps,
  TaskRuns, step executions, artifacts. It also orchestrates: it decides the
  next step, evaluates routes, schedules children and completes tasks.
- **Daemon** (`vtb-daemon`, local) executes the steps the backend dispatches to it:
  `llm_inference` (on the `claude` or `codex` harness) and
  `structured_inference` (on the `typesafe` harness), and [execute](workflows/steps/execute/index.md)
  (pure Rhai JSON transformations without a harness). Inference steps select
  their harness. The daemon reports results; it does not decide routing.
- **vtb CLI** and the **GUI** are clients of the backend. The GUI also hosts local
  chat sessions (this conversation, if you are running inside it).
- A project is resolved from the working directory (see [setup](setup/index.md)).

## Glossary
- Task: a unit of work with a level: `epic`, `ticket` or `task`.
- Workflow: an ordered set of steps plus transitions; a task is assigned to one workflow at a time.
- Factory: a named group of related workflows (`--factory-name`).
- Step: one node in a workflow; its type decides who handles it.
- Harness: the provider runtime (`claude`, `codex`, `typesafe`) that executes an inference step; execute does not use one.
- Step transition / workflow transition: allowed edges between steps / between workflows.
- TaskRun: one durable automation run of a task through its workflow(s).
- Step execution: one attempt at one step inside a TaskRun.
- Handoff: structured data a route passes to the next step.
- Artifact: a stored file (often JSON) attached to a project, task or run.

## Related
[Workflows](workflows/index.md) · [Running](running/index.md) · [Permissions](permissions.md)
