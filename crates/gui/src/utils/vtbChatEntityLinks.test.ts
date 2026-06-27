import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/chatStore";
import {
  buildVtbEntityIndex,
  getIndexedVtbEntity,
  linkifyKnownVtbEntities,
} from "./vtbChatEntityLinks";

const TS = "2026-06-27T12:00:00.000Z";

function bashCall(toolId: string, command: string): ChatMessage {
  return {
    kind: "tool_call",
    toolName: "Bash",
    toolId,
    input: JSON.stringify({ command }),
    timestamp: TS,
  };
}

function toolResult(toolId: string, result: unknown): ChatMessage {
  return {
    kind: "tool_result",
    toolId,
    result: typeof result === "string" ? result : JSON.stringify(result),
    isError: false,
    timestamp: TS,
  };
}

function indexedTicket(shortId: string, title: string) {
  return {
    id: `${shortId}-1111-4111-8111-111111111111`,
    level: "ticket",
    title,
  };
}

describe("vtbChatEntityLinks", () => {
  it("indexes task-like entities from paired vtb list JSON output", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level ticket"),
      toolResult("tool-1", [
        {
          id: "03111754-4769-47c1-a64c-078d73554af8",
          level: "ticket",
          title: "System-prompt-driven typed resource links in chat",
        },
      ]),
    ]);

    expect(getIndexedVtbEntity(index, "03111754")).toMatchObject({
      id: "03111754-4769-47c1-a64c-078d73554af8",
      type: "ticket",
      title: "System-prompt-driven typed resource links in chat",
    });
  });

  it("indexes vtb JSON wrapped in tool result text blocks", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level ticket"),
      toolResult(
        "tool-1",
        JSON.stringify([
          {
            type: "text",
            text: JSON.stringify([
              {
                id: "85057de6-ab1d-4c5f-b7a6-c03bc7d2f8e8",
                level: "ticket",
                title: "Manual implementation of Hearth v2 GUI",
              },
            ]),
          },
        ])
      ),
    ]);

    expect(getIndexedVtbEntity(index, "85057de6")).toMatchObject({
      id: "85057de6-ab1d-4c5f-b7a6-c03bc7d2f8e8",
      type: "ticket",
      title: "Manual implementation of Hearth v2 GUI",
    });
  });

  it("indexes vtb JSON wrapped in command stdout fields", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level ticket"),
      toolResult("tool-1", {
        stdout: JSON.stringify([
          {
            id: "79c40516-4264-4f6c-a121-75463bb5bf35",
            level: "ticket",
            title: "Support streaming assistant output in Sacrum live chat",
          },
        ]),
        stderr: "",
      }),
    ]);

    expect(getIndexedVtbEntity(index, "79c40516")).toMatchObject({
      id: "79c40516-4264-4f6c-a121-75463bb5bf35",
      type: "ticket",
      title: "Support streaming assistant output in Sacrum live chat",
    });
  });

  it("indexes parent epic stubs from ticket list JSON parent IDs", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level ticket --flat"),
      toolResult("tool-1", [
        {
          id: "79c40516-4264-4f6c-a121-75463bb5bf35",
          level: "ticket",
          parent_id: "b3d4f53b-79a3-43e1-a6e5-3db38e0b6f71",
          title: "Support streaming assistant output in Sacrum live chat",
        },
      ]),
    ]);

    expect(getIndexedVtbEntity(index, "b3d4f53b")).toMatchObject({
      id: "b3d4f53b-79a3-43e1-a6e5-3db38e0b6f71",
      type: "epic",
      title: "",
    });
  });

  it("replaces title-less parent guesses with real entity records", () => {
    const epicId = "b3d4f53b-79a3-43e1-a6e5-3db38e0b6f71";
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level task --flat"),
      toolResult("tool-1", [
        {
          id: "90e157f0-3333-4333-8333-333333333333",
          level: "task",
          parent_id: epicId,
          title: "Restructure AppShell: topbar over rail",
        },
        {
          id: epicId,
          level: "epic",
          title: "Local Chat Features",
        },
      ]),
    ]);

    expect(getIndexedVtbEntity(index, "b3d4f53b")).toMatchObject({
      id: epicId,
      type: "epic",
      title: "Local Chat Features",
    });
  });

  it("recognizes vtb inspection commands behind shell directory changes", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "cd /tmp/project && vtb list --level ticket"),
      toolResult("tool-1", [
        {
          id: "03111754-4769-47c1-a64c-078d73554af8",
          level: "ticket",
          title: "System-prompt-driven typed resource links in chat",
        },
      ]),
    ]);

    expect(getIndexedVtbEntity(index, "03111754")).toMatchObject({
      type: "ticket",
      title: "System-prompt-driven typed resource links in chat",
    });
  });

  it("indexes workflows and steps from structured vtb command output", () => {
    const index = buildVtbEntityIndex([
      bashCall("workflow-list", "vtb workflow list"),
      toolResult("workflow-list", [
        {
          id: "bfeeab03-8828-484b-b620-b2eeb83af1b0",
          name: "Implementation",
          step_count: 3,
        },
      ]),
      bashCall(
        "step-list",
        "vtb step list bfeeab03-8828-484b-b620-b2eeb83af1b0"
      ),
      toolResult("step-list", [
        {
          id: "bb5b4dec-81f5-451d-97a8-e4b4db52cef0",
          name: "in_progress",
          workflow_id: "bfeeab03-8828-484b-b620-b2eeb83af1b0",
        },
      ]),
    ]);

    expect(getIndexedVtbEntity(index, "bfeeab03")).toMatchObject({
      type: "workflow",
      title: "Implementation",
    });
    expect(getIndexedVtbEntity(index, "bb5b4dec")).toMatchObject({
      type: "step",
      title: "in_progress",
      workflowId: "bfeeab03-8828-484b-b620-b2eeb83af1b0",
    });
  });

  it("inherits workflow ids from nested workflow show steps", () => {
    const backlogId = "f7e162c1-b4ef-4622-aded-4c96412a2f35";
    const implementationId = "bfeeab03-8828-484b-b620-b2eeb83af1b0";
    const backlogTodoId = "0cb79654-918d-490d-8505-43e7a2dec3dd";
    const backlogDoneId = "625349e0-9c2d-4b20-9b40-d5d950507a06";
    const implementationTodoId = "3cf2368d-8668-46e3-992b-d409231e10d6";
    const index = buildVtbEntityIndex([
      bashCall(
        "workflow-show-loop",
        `for workflow_id in "${backlogId}" "${implementationId}"; do vtb workflow show "$workflow_id"; done`
      ),
      toolResult(
        "workflow-show-loop",
        [
          JSON.stringify(
            {
              id: backlogId,
              is_default: true,
              name: "Backlog",
              steps: [
                {
                  id: backlogTodoId,
                  name: "todo",
                  order: 0,
                },
                {
                  id: backlogDoneId,
                  name: "done",
                  order: 2,
                },
              ],
            },
            null,
            2
          ),
          JSON.stringify(
            {
              id: implementationId,
              is_default: false,
              name: "Implementation",
              steps: [
                {
                  id: implementationTodoId,
                  name: "todo",
                  order: 0,
                },
              ],
            },
            null,
            2
          ),
        ].join("\n")
      ),
    ]);

    expect(getIndexedVtbEntity(index, backlogTodoId)).toMatchObject({
      type: "step",
      title: "todo",
      workflowId: backlogId,
    });
    expect(getIndexedVtbEntity(index, implementationTodoId)).toMatchObject({
      type: "step",
      title: "todo",
      workflowId: implementationId,
    });
    expect(
      linkifyKnownVtbEntities(
        [
          "Here are the steps in each workflow:",
          "",
          "Backlog (Default - 3 steps)",
          "1. todo",
          "2. done",
          "",
          "Implementation (3 steps)",
          "1. todo",
        ].join("\n"),
        index
      )
    ).toBe(
      [
        "Here are the steps in each workflow:",
        "",
        `[Backlog](vtb://workflow/${backlogId}) (Default - 3 steps)`,
        `1. [todo](vtb://step/${backlogTodoId})`,
        `2. [done](vtb://step/${backlogDoneId})`,
        "",
        `[Implementation](vtb://workflow/${implementationId}) (3 steps)`,
        `1. [todo](vtb://step/${implementationTodoId})`,
      ].join("\n")
    );
  });

  it("ignores unstructured and unrelated tool output", () => {
    const index = buildVtbEntityIndex([
      bashCall("piped", "vtb list --level task | grep chat"),
      toolResult("piped", "0ad043dc GUI: color by step_type"),
      bashCall("cat", "cat README.md"),
      toolResult("cat", [
        {
          id: "0ad043dc-1111-4111-8111-111111111111",
          level: "task",
          title: "Should not be indexed",
        },
      ]),
    ]);

    expect(getIndexedVtbEntity(index, "0ad043dc")).toBeNull();
  });

  it("does not link ambiguous short IDs", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list"),
      toolResult("tool-1", [
        {
          id: "0ad043dc-1111-4111-8111-111111111111",
          level: "task",
          title: "First matching task",
        },
        {
          id: "0ad043dc-2222-4222-8222-222222222222",
          level: "task",
          title: "Second matching task",
        },
      ]),
    ]);

    expect(getIndexedVtbEntity(index, "0ad043dc")).toBeNull();
    expect(
      linkifyKnownVtbEntities("- 0ad043dc First matching task", index)
    ).toBe("- 0ad043dc First matching task");
    expect(
      linkifyKnownVtbEntities(
        "- 0ad043dc-1111-4111-8111-111111111111 First matching task",
        index
      )
    ).toBe(
      "- [First matching task](vtb://task/0ad043dc-1111-4111-8111-111111111111)"
    );
  });

  it("renders known row IDs as title links and removes duplicate titles", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level ticket"),
      toolResult("tool-1", [
        {
          id: "03111754-4769-47c1-a64c-078d73554af8",
          level: "ticket",
          title: "System-prompt-driven typed resource links in chat",
        },
      ]),
    ]);

    expect(
      linkifyKnownVtbEntities(
        "• ◇ 03111754-4769-47c1-a64c-078d73554af8 — System-prompt-driven typed resource links in chat (Implementation:done)",
        index
      )
    ).toBe(
      "• [System-prompt-driven typed resource links in chat](vtb://ticket/03111754-4769-47c1-a64c-078d73554af8) (Implementation:done)"
    );
  });

  it("collapses title plus parenthesized short ID into one title link", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level ticket --flat"),
      toolResult("tool-1", [
        {
          id: "85057de6-1111-4111-8111-111111111111",
          level: "ticket",
          title: "Manual implementation of Hearth v2 GUI",
        },
        {
          id: "53881050-abb2-4d46-9b58-b7a6001dacc3",
          level: "ticket",
          title: "Add GUI controls to resolve Human Review tasks",
        },
        {
          id: "90e157f0-3333-4333-8333-333333333333",
          level: "task",
          title: "Restructure AppShell: topbar over rail",
        },
      ]),
    ]);

    expect(
      linkifyKnownVtbEntities(
        "- **Manual implementation of Hearth v2 GUI** (◇ 85057de6)",
        index
      )
    ).toBe(
      "- **[Manual implementation of Hearth v2 GUI](vtb://ticket/85057de6-1111-4111-8111-111111111111)**"
    );
    expect(
      linkifyKnownVtbEntities(
        "2. Add GUI controls to resolve Human Review tasks (◇ 53881050)",
        index
      )
    ).toBe(
      "2. [Add GUI controls to resolve Human Review tasks](vtb://ticket/53881050-abb2-4d46-9b58-b7a6001dacc3)"
    );
  });

  it("collapses known title/id pairs across common orders and separators", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level ticket --flat"),
      toolResult("tool-1", [
        {
          id: "85057de6-1111-4111-8111-111111111111",
          level: "ticket",
          title: "Manual implementation of Hearth v2 GUI",
        },
        {
          id: "53881050-abb2-4d46-9b58-b7a6001dacc3",
          level: "ticket",
          title: "Add GUI controls to resolve Human Review tasks",
        },
        {
          id: "90e157f0-3333-4333-8333-333333333333",
          level: "task",
          title: "Restructure AppShell: topbar over rail",
        },
      ]),
    ]);

    expect(
      linkifyKnownVtbEntities(
        "Manual implementation of Hearth v2 GUI - 85057de6",
        index
      )
    ).toBe(
      "[Manual implementation of Hearth v2 GUI](vtb://ticket/85057de6-1111-4111-8111-111111111111)"
    );
    expect(
      linkifyKnownVtbEntities(
        "85057de6 - Manual implementation of Hearth v2 GUI",
        index
      )
    ).toBe(
      "[Manual implementation of Hearth v2 GUI](vtb://ticket/85057de6-1111-4111-8111-111111111111)"
    );
    expect(
      linkifyKnownVtbEntities(
        "(53881050) Add GUI controls to resolve Human Review tasks",
        index
      )
    ).toBe(
      "[Add GUI controls to resolve Human Review tasks](vtb://ticket/53881050-abb2-4d46-9b58-b7a6001dacc3)"
    );
    expect(
      linkifyKnownVtbEntities(
        "◇ 53881050 Add GUI controls to resolve Human Review tasks",
        index
      )
    ).toBe(
      "[Add GUI controls to resolve Human Review tasks](vtb://ticket/53881050-abb2-4d46-9b58-b7a6001dacc3)"
    );
    expect(
      linkifyKnownVtbEntities(
        "◇ 85057de6 Manual implementation of Hearth v2 GUI - Manual implementation of Hearth v2 GUI",
        index
      )
    ).toBe(
      "[Manual implementation of Hearth v2 GUI](vtb://ticket/85057de6-1111-4111-8111-111111111111)"
    );
    expect(
      linkifyKnownVtbEntities(
        "Manual implementation of Hearth v2 GUI - 85057de6 - Manual implementation of Hearth v2 GUI",
        index
      )
    ).toBe(
      "[Manual implementation of Hearth v2 GUI](vtb://ticket/85057de6-1111-4111-8111-111111111111)"
    );
    expect(
      linkifyKnownVtbEntities(
        "90e157f0 - Restructure AppShell: topbar over rail",
        index
      )
    ).toBe(
      "[Restructure AppShell: topbar over rail](vtb://task/90e157f0-3333-4333-8333-333333333333)"
    );
  });

  it("collapses status-grouped ticket rows rendered as short id em dash title", () => {
    const tickets = [
      indexedTicket("85057de6", "Manual implementation of Hearth v2 GUI"),
      indexedTicket(
        "79c40516",
        "Support streaming assistant output in Sacrum live chat"
      ),
      indexedTicket(
        "53881050",
        "Add GUI controls to resolve Human Review tasks"
      ),
      indexedTicket(
        "5396f73e",
        "Support multiple main GUI windows for separate projects"
      ),
      indexedTicket(
        "b4ede37e",
        "GUI acceptance: realtime per-step pipeline counts as a task runs through the orchestrator"
      ),
      indexedTicket(
        "21795f03",
        "Refresh /styleguide to render the production Hearth v2 component catalog"
      ),
      indexedTicket(
        "c4cfb10c",
        "Remove app compatibility layer; adopt docs/design as token source of truth"
      ),
      indexedTicket(
        "1a2d3b27",
        "Restore done-task list controls: hide-done toggle + summary rows"
      ),
      indexedTicket(
        "d2e04503",
        "GUI: derive task workflow_name/step_name/step_type from local caches on realtime TaskChanged events instead of refetching"
      ),
      indexedTicket("b98b255c", "Analyze Vertebrae product surface"),
      indexedTicket("d9f8a130", "Analyze Sacrum backend surface"),
      indexedTicket("4f73aa9b", "Analyze current market and competitors"),
      indexedTicket("9fd9afbd", "Synthesize marketing strategy"),
    ];
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level ticket"),
      toolResult("tool-1", tickets),
    ]);

    expect(
      linkifyKnownVtbEntities(
        [
          "In Progress",
          "85057de6 — Manual implementation of Hearth v2 GUI",
          "Todo",
          "79c40516 — Support streaming assistant output in Sacrum live chat",
          "53881050 — Add GUI controls to resolve Human Review tasks",
          "5396f73e — Support multiple main GUI windows for separate projects",
          "b4ede37e — GUI acceptance: realtime per-step pipeline counts as a task runs through the orchestrator",
          "21795f03 — Refresh /styleguide to render the production Hearth v2 component catalog [hearth, gui, styleguide]",
          "c4cfb10c — Remove app compatibility layer; adopt docs/design as token source of truth",
          "1a2d3b27 — Restore done-task list controls: hide-done toggle + summary rows",
          "d2e04503 — GUI: derive task workflow_name/step_name/step_type from local caches on realtime TaskChanged events instead of refetching",
          "Marketing analysis epic (todo)",
          "b98b255c — Analyze Vertebrae product surface",
          "d9f8a130 — Analyze Sacrum backend surface",
          "4f73aa9b — Analyze current market and competitors",
          "9fd9afbd — Synthesize marketing strategy",
        ].join("\n"),
        index
      )
    ).toBe(
      [
        "In Progress",
        "[Manual implementation of Hearth v2 GUI](vtb://ticket/85057de6-1111-4111-8111-111111111111)",
        "Todo",
        "[Support streaming assistant output in Sacrum live chat](vtb://ticket/79c40516-1111-4111-8111-111111111111)",
        "[Add GUI controls to resolve Human Review tasks](vtb://ticket/53881050-1111-4111-8111-111111111111)",
        "[Support multiple main GUI windows for separate projects](vtb://ticket/5396f73e-1111-4111-8111-111111111111)",
        "[GUI acceptance: realtime per-step pipeline counts as a task runs through the orchestrator](vtb://ticket/b4ede37e-1111-4111-8111-111111111111)",
        "[Refresh /styleguide to render the production Hearth v2 component catalog](vtb://ticket/21795f03-1111-4111-8111-111111111111) [hearth, gui, styleguide]",
        "[Remove app compatibility layer; adopt docs/design as token source of truth](vtb://ticket/c4cfb10c-1111-4111-8111-111111111111)",
        "[Restore done-task list controls: hide-done toggle + summary rows](vtb://ticket/1a2d3b27-1111-4111-8111-111111111111)",
        "[GUI: derive task workflow_name/step_name/step_type from local caches on realtime TaskChanged events instead of refetching](vtb://ticket/d2e04503-1111-4111-8111-111111111111)",
        "Marketing analysis epic (todo)",
        "[Analyze Vertebrae product surface](vtb://ticket/b98b255c-1111-4111-8111-111111111111)",
        "[Analyze Sacrum backend surface](vtb://ticket/d9f8a130-1111-4111-8111-111111111111)",
        "[Analyze current market and competitors](vtb://ticket/4f73aa9b-1111-4111-8111-111111111111)",
        "[Synthesize marketing strategy](vtb://ticket/9fd9afbd-1111-4111-8111-111111111111)",
      ].join("\n")
    );
  });

  it("does not link a mismatched standalone short id outside an entity section", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level ticket --flat"),
      toolResult("tool-1", [
        {
          id: "85057de6-1111-4111-8111-111111111111",
          level: "ticket",
          title: "Manual implementation of Hearth v2 GUI",
        },
      ]),
    ]);

    expect(linkifyKnownVtbEntities("A different title - 85057de6", index)).toBe(
      "A different title - 85057de6"
    );
  });

  it("uses visible titles to link parent epic short IDs from structured parent IDs", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level ticket --flat"),
      toolResult("tool-1", [
        {
          id: "79c40516-4264-4f6c-a121-75463bb5bf35",
          level: "ticket",
          parent_id: "b3d4f53b-79a3-43e1-a6e5-3db38e0b6f71",
          title: "Support streaming assistant output in Sacrum live chat",
        },
        {
          id: "4f73aa9b-1111-4111-8111-111111111111",
          level: "ticket",
          parent_id: "0faffd66-2222-4222-8222-222222222222",
          title:
            "Refresh /styleguide to render the production Hearth v2 component catalog",
        },
      ]),
    ]);

    expect(
      linkifyKnownVtbEntities("Local Chat Features (b3d4f53b)", index)
    ).toBe(
      "[Local Chat Features](vtb://epic/b3d4f53b-79a3-43e1-a6e5-3db38e0b6f71)"
    );
    expect(
      linkifyKnownVtbEntities("b3d4f53b - Local Chat Features", index)
    ).toBe(
      "[Local Chat Features](vtb://epic/b3d4f53b-79a3-43e1-a6e5-3db38e0b6f71)"
    );
    expect(
      linkifyKnownVtbEntities(
        "Parent epic: GUI Modernization (0faffd66)",
        index
      )
    ).toBe(
      "Parent epic: [GUI Modernization](vtb://epic/0faffd66-2222-4222-8222-222222222222)"
    );
  });

  it("links known comma-separated IDs by title", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level task"),
      toolResult("tool-1", [
        {
          id: "0ad043dc-1111-4111-8111-111111111111",
          level: "task",
          title: "GUI: color by step_type + toggle step colors",
        },
        {
          id: "123fac3d-2222-4222-8222-222222222222",
          level: "task",
          title: "Remove GraphQL live-session chat runner",
        },
        {
          id: "1b847358-3333-4333-8333-333333333333",
          level: "task",
          title: "GUI: derive task status from completed_at",
        },
      ]),
    ]);

    expect(
      linkifyKnownVtbEntities("Tasks:\nDone: 0ad043dc, 123fac3d", index)
    ).toBe(
      "Tasks:\nDone: [GUI: color by step_type + toggle step colors](vtb://task/0ad043dc-1111-4111-8111-111111111111), [Remove GraphQL live-session chat runner](vtb://task/123fac3d-2222-4222-8222-222222222222)"
    );
    expect(
      linkifyKnownVtbEntities(
        "Tasks:\nDone: 0ad043dc GUI: color by step_type + toggle step colors, 123fac3d, 1b847358",
        index
      )
    ).toBe(
      "Tasks:\nDone: [GUI: color by step_type + toggle step colors](vtb://task/0ad043dc-1111-4111-8111-111111111111), [Remove GraphQL live-session chat runner](vtb://task/123fac3d-2222-4222-8222-222222222222), [GUI: derive task status from completed_at](vtb://task/1b847358-3333-4333-8333-333333333333)"
    );
  });

  it("links title-only task rows under status-grouped task sections", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level task"),
      toolResult("tool-1", [
        {
          id: "0ad043dc-1111-4111-8111-111111111111",
          level: "task",
          title: "GUI: color by step_type + toggle step colors",
        },
        {
          id: "123fac3d-2222-4222-8222-222222222222",
          level: "task",
          title: "Remove GraphQL live-session chat runner",
        },
      ]),
    ]);

    expect(
      linkifyKnownVtbEntities(
        [
          "Here are all the tasks under this epic (grouped by status):",
          "",
          "Finished (done):",
          "- GUI: color by step_type + toggle step colors",
          "- Remove GraphQL live-session chat runner",
          "",
          "Summary: GUI: color by step_type + toggle step colors should stay plain here",
        ].join("\n"),
        index
      )
    ).toBe(
      [
        "Here are all the tasks under this epic (grouped by status):",
        "",
        "Finished (done):",
        "- [GUI: color by step_type + toggle step colors](vtb://task/0ad043dc-1111-4111-8111-111111111111)",
        "- [Remove GraphQL live-session chat runner](vtb://task/123fac3d-2222-4222-8222-222222222222)",
        "",
        "Summary: GUI: color by step_type + toggle step colors should stay plain here",
      ].join("\n")
    );
  });

  it("does not fabricate links from unknown short ids under section headings", () => {
    const index = buildVtbEntityIndex([]);
    const text = [
      "Tasks (41 total)",
      "- TODO (3):",
      "  - 90e157f0 - Restructure AppShell: topbar over rail",
      "Workflows:",
      "- bfeeab03 - Implementation",
      "Steps:",
      "- bb5b4dec - in_progress",
      "Summary: leave 0ad043dc alone here",
    ].join("\n");

    expect(linkifyKnownVtbEntities(text, index)).toBe(text);
  });

  it("links title-only workflow tables from structured workflow output", () => {
    const backlogId = "11111111-1111-4111-8111-111111111111";
    const implementationId = "22222222-2222-4222-8222-222222222222";
    const index = buildVtbEntityIndex([
      bashCall("workflow-list", "vtb workflow list"),
      toolResult("workflow-list", [
        {
          id: backlogId,
          name: "Backlog",
          step_count: 3,
          is_default: true,
        },
        {
          id: implementationId,
          name: "Implementation",
          step_count: 3,
        },
      ]),
    ]);

    expect(
      linkifyKnownVtbEntities(
        [
          "You have 2 workflows in this project:",
          "",
          "| Workflow | Steps | Default | Description |",
          "| --- | ---: | --- | --- |",
          "| Backlog | 3 | ✓ | Triage first |",
          "| Implementation | 3 |  | Build it |",
        ].join("\n"),
        index
      )
    ).toBe(
      [
        "You have 2 workflows in this project:",
        "",
        "| Workflow | Steps | Default | Description |",
        "| --- | ---: | --- | --- |",
        `| [Backlog](vtb://workflow/${backlogId}) | 3 | ✓ | Triage first |`,
        `| [Implementation](vtb://workflow/${implementationId}) | 3 |  | Build it |`,
      ].join("\n")
    );
  });

  it("links title-only steps within the current workflow group", () => {
    const backlogId = "11111111-1111-4111-8111-111111111111";
    const implementationId = "22222222-2222-4222-8222-222222222222";
    const backlogTodoId = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
    const backlogDoneId = "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
    const implementationTodoId = "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
    const implementationProgressId = "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
    const index = buildVtbEntityIndex([
      bashCall("workflow-list", "vtb workflow list"),
      toolResult("workflow-list", [
        {
          id: backlogId,
          name: "Backlog",
          step_count: 3,
          is_default: true,
        },
        {
          id: implementationId,
          name: "Implementation",
          step_count: 3,
        },
      ]),
      bashCall("backlog-steps", `vtb step list ${backlogId}`),
      toolResult("backlog-steps", [
        {
          id: backlogTodoId,
          name: "todo",
          workflow_id: backlogId,
        },
        {
          id: backlogDoneId,
          name: "done",
          workflow_id: backlogId,
        },
      ]),
      bashCall("implementation-steps", `vtb step list ${implementationId}`),
      toolResult("implementation-steps", [
        {
          id: implementationTodoId,
          name: "todo",
          workflow_id: implementationId,
        },
        {
          id: implementationProgressId,
          name: "in_progress",
          workflow_id: implementationId,
        },
      ]),
    ]);

    expect(
      linkifyKnownVtbEntities(
        [
          "Here are the steps in each workflow:",
          "",
          "Backlog (Default - 3 steps)",
          "1. todo",
          "2. done",
          "",
          "**Implementation (3 steps)**",
          "1. todo",
          "2. in_progress",
          "",
          "Summary: todo should stay plain",
        ].join("\n"),
        index
      )
    ).toBe(
      [
        "Here are the steps in each workflow:",
        "",
        `[Backlog](vtb://workflow/${backlogId}) (Default - 3 steps)`,
        `1. [todo](vtb://step/${backlogTodoId})`,
        `2. [done](vtb://step/${backlogDoneId})`,
        "",
        `**[Implementation](vtb://workflow/${implementationId}) (3 steps)**`,
        `1. [todo](vtb://step/${implementationTodoId})`,
        `2. [in_progress](vtb://step/${implementationProgressId})`,
        "",
        "Summary: todo should stay plain",
      ].join("\n")
    );
  });

  it("skips code spans and existing markdown links without suppressing the whole line", () => {
    const index = buildVtbEntityIndex([
      bashCall("tool-1", "vtb list --level task"),
      toolResult("tool-1", [
        {
          id: "0ad043dc-1111-4111-8111-111111111111",
          level: "task",
          title: "GUI: color by step_type + toggle step colors",
        },
      ]),
    ]);

    expect(
      linkifyKnownVtbEntities(
        [
          "```",
          "0ad043dc GUI: color by step_type + toggle step colors",
          "```",
          "Run `vtb show 0ad043dc` and see [docs](https://example.com) for 0ad043dc-1111-4111-8111-111111111111",
          "Already [0ad043dc](vtb://task/0ad043dc-1111-4111-8111-111111111111)",
        ].join("\n"),
        index
      )
    ).toBe(
      [
        "```",
        "0ad043dc GUI: color by step_type + toggle step colors",
        "```",
        "Run `vtb show 0ad043dc` and see [docs](https://example.com) for [GUI: color by step_type + toggle step colors](vtb://task/0ad043dc-1111-4111-8111-111111111111)",
        "Already [0ad043dc](vtb://task/0ad043dc-1111-4111-8111-111111111111)",
      ].join("\n")
    );
  });
});
