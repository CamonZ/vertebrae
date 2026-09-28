# Authoring tasks

Purpose: create tasks that humans and workflow steps can act on.
Use this when: the user asks to create or reshape an epic, ticket or task.

## What you can do
Create (`vtb add`), set level, description, priority, tags, parent,
dependencies, workflow and worktree at creation, and edit them later (`vtb update`).

## How it works
- Levels: `epic` > `ticket` > `task`. Levels are a closed set, so routes can
  branch on `task.level` without a default.
- The description and sections are the task's inputs: prompts see
  `task.title`, `task.description`, `task.worktree`, sections and code refs
  (see [templating context](../templating/context.md)). Write descriptions the
  executing agent can act on without the chat history.
- Tags are free-form strings and routable (`task.tags contains ...`). Because
  the tag domain is open, routes branching on tags need a `default`.
- `--worktree` records the checkout a run should work in; prompts read it as `task.worktree`.
- `--workflow` assigns a workflow at creation. Assigning later is `vtb workflow assign`,
  which needs consent (see [permissions](../permissions.md)).

## Doing it
`vtb add "<title>" -l ticket -d "<description>" -p medium -t docs -t gui`,
plus `--parent`, `--depends-on`, `--worktree` as needed. See `vtb add --help`.
Put goals, constraints and acceptance criteria in [sections](sections.md), not only in prose.

## Gotchas
- `vtb` resolves the project from the current directory; run it inside the project checkout.
- A task created with a workflow does not start running; a TaskRun is started separately.

## Related
[Sections](sections.md) · [Relationships](relationships/index.md) · [Running](../running/index.md)
