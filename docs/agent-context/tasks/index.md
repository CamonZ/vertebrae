# Tasks

Tasks are the units Vertebrae tracks and runs. Read the entry that matches the request.

- [Authoring](authoring.md): levels, titles, descriptions, priority, tags, worktree.
  Load when: "create a ticket/epic/task", writing a good description, choosing tags that routes can use.
- [Sections](sections.md): typed content (goals, constraints, testing criteria...) and how prompts see it.
  Load when: adding acceptance criteria, constraints, checklists, or referencing sections in a prompt.
- [Code refs](code-refs.md): pointing a task at files and line ranges.
  Load when: "link this file to the ticket", `vtb ref`, `task.code_refs` in a prompt.
- [Relationships](relationships/index.md): parent/child decomposition and dependencies.
  Load when: "break this epic down", subtasks, "X blocks Y", `vtb ready`, `wait_children` planning.
- [Managing](managing.md): finding, updating, archiving and deleting tasks.
  Load when: "show me", "what's next", `vtb list/show/update/archive/delete`.
