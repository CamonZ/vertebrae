# Vertebrae — UX Specification

> Screen-by-screen interaction design for an AI workflow orchestration tool.  
> Designed to compete with world-class products like Linear, Notion, and Vercel.

---

## Table of Contents

1. [Product Mental Model](#1-product-mental-model)
2. [Information Architecture](#2-information-architecture)
3. [The Shell — Navigation & Persistent UI](#3-the-shell)
4. [Screen: Setup / First Launch](#4-setup--first-launch)
5. [Screen: Operations (Home)](#5-operations)
6. [Screen: Board](#6-board)
7. [Screen: Tasks](#7-tasks)
8. [Screen: Design](#8-design)
9. [Screen: Traces](#9-traces)
10. [Overlay: Task Detail Panel](#10-task-detail-panel)
11. [Overlay: Chat Panel](#11-chat-panel)
12. [Command Palette](#12-command-palette)
13. [Context Menus](#13-context-menus)
14. [Keyboard Shortcuts](#14-keyboard-shortcuts)
15. [User Journeys](#15-user-journeys)
16. [Micro-interactions & Motion](#16-micro-interactions--motion)
17. [Empty & Loading States](#17-empty--loading-states)
18. [Responsive & Focus Modes](#18-responsive--focus-modes)
19. [Settings](#19-settings)

---

## 1. Product Mental Model

Vertebrae is the mission control for teams where **AI agents do the work and humans provide direction**. It sits at the intersection of a project management tool and an AI execution runtime.

### The three things a user cares about

1. **What needs my attention right now?** — Failed runs, review requests, blocked tasks.
2. **What is the system doing?** — Running agents, live progress, recent completions.
3. **What did the system produce?** — Agent outputs, execution logs, accepted/rejected work.

Everything in the interface answers one of these three questions.

### The core objects

| Object | What it is | Primary screen |
|--------|-----------|----------------|
| **Task** | A unit of work (epic → ticket → task hierarchy) | Tasks, Board |
| **Workflow** | The pipeline a task moves through | Design |
| **Step** | A stage within a workflow; can run an AI agent | Design, Traces |
| **Run** | One execution of a step for a task | Operations, Traces |
| **Trace** | The full log of what an agent did in a run | Traces |

### Progressive disclosure levels

Every object in the system has three levels of visibility:

- **Glance** — visible in a list row: title + status + recency
- **Focus** — visible in the detail panel: all fields, sections, actions
- **Deep dive** — visible in a pop-out window or trace inspector: full execution log, raw data

The interface defaults to Glance. Focus requires a click. Deep dive requires deliberate action.

---

## 2. Information Architecture

```
vertebrae/
├── Setup                    (no project loaded)
│
├── Operations               (home — live activity feed)
│
├── Board                    (kanban by workflow step)
│
├── Tasks                    (hierarchical tree)
│
├── Design                   (workflow DAG editor)
│
└── Traces                   (agent execution inspector)
     ├── [task selected]
     │    ├── Run history
     │    └── Subtree executions
     └── [run selected]
          └── Execution trace (Thread / Timeline)

Overlays (appear on top of any screen):
├── Task Detail Panel        (right side panel)
├── Step Detail Panel        (right side panel)
├── Chat Panel               (floating, bottom-right)
└── Pop-out Windows          (detached for focus)
```

---

## 3. The Shell

The application shell wraps every screen. It is the unchanging skeleton: sidebar + header + content.

### 3.1 Sidebar

```
┌────┐
│    │  4px padding
│ V  │  ← Vertebrae logo mark (28px, centered)
│    │  4px padding
├────┤  1px border-subtle
│    │  6px padding
│ █P │  ← Project avatar (28px × 28px, radius-md)
│ ▾  │    background: hashed from project name (8 color options)
│    │    letter: first char of project name, white mono
│    │  6px padding
├────┤  1px border-subtle
│    │  8px padding
│ ⬡  │  ← Operations   [⬤ 6px red dot upper-right if needs attention]
│ ⊞  │  ← Board
│ ◈  │  ← Design
│    │  ─ 1px divider (border-subtle)
│ ≡  │  ← Tasks
│ ⟳  │  ← Traces
│    │  flex-grow spacer
│ 💬 │  ← Project Chat   [pulse if active session streaming]
│ ◑  │  ← Theme toggle
└────┘
```

**Width:** 48px, always visible, never collapses.

**Active state:** 2px left border in `accent-default`, `accent-subtle` background fill on the icon area.

**Hover state:** Icon background shifts to `interactive-hover` immediately (0ms). Tooltip appears after 400ms showing page name or full project path.

**Project avatar:** Color is deterministically derived from the project name hash — no setup required. Clicking opens a popover (220px wide) listing known projects with a checkmark on the current one, and "Open directory…" at the bottom.

**Notification dot:** A 6px solid circle in `status-error` appears at the upper-right of the Operations icon when any tasks need attention (failed runs or pending reviews). No number — presence alone signals urgency. Disappears when Needs Attention section is empty.

**Chat button:** Opens the Chat Panel. Subtle pulse animation when a response is streaming.

### 3.2 Header

```
┌────────────────────────────────────────────────────┐
│  myproject  ›  Operations              ● 3 running  │
└────────────────────────────────────────────────────┘
```

**Height:** 48px.

**Left — breadcrumb format:**
- Project name: `text-sm` weight-400, `text-tertiary` color
- Separator `›`: `text-tertiary` at 50% opacity, `text-sm`
- Page title: `text-xl` weight-600, `text-primary` color

All three elements share a single baseline. The project name is not interactive — it is ambient context. The project can only be changed via the sidebar project switcher.

**When no project is loaded** (Setup screen): breadcrumb is absent; only `Vertebrae` shown in `text-xl`.

**Right:** Contextual status or action area per page:
- Operations: "● N running" live counter (green dot + count, fades to hidden when 0)
- Board: level filter chips (Epic / Ticket / Task)
- Tasks: task count ("142 tasks")
- Design: nothing
- Traces: view mode toggle (Thread / Timeline) + "■ Stop" when run is active

**Window title bar (OS level):** Always shows `[project name] — Vertebrae` to provide project identity at the OS level (visible in the Dock, window switcher, etc.).

**Height** is always 48px. The header does not scroll.

### 3.3 OS Notifications

Vertebrae runs agents in the background. Users need to know when their attention is required without watching the app.

**Notification triggers (opt-in per type, configured in settings):**

| Event | Notification |
|-------|-------------|
| Run failed | "❌ [Task title] failed" |
| Pending review | "👁 [Task title] needs your review" |
| Run completed | "✓ [Task title] finished" |

**Notification behavior:**
- Clicking a notification brings Vertebrae to the foreground and navigates directly to the relevant task (detail panel open)
- Notifications are grouped by task: if 3 runs complete in rapid succession, one notification is shown ("3 runs completed")
- No notifications while the app is in the foreground (in-app activity is sufficient)

**Default notification settings:**
- Run failed: ✅ on
- Pending review: ✅ on
- Run completed: off (high volume, opt-in)

### 3.4 Connection Status

When disconnected from the daemon, a slim banner replaces the header's right area:

```
│  Operations              ⚡ Reconnecting...         │
```

The banner uses `status-warning` color. When connected, it disappears immediately (no success flash — absence of warning is success).

---

## 4. Setup / First Launch

This screen appears when the application has no project configured. It is the only screen where the sidebar is partially hidden (the project switcher and nav icons are visible but dimmed and non-interactive).

### 4.1 Layout

```
┌──────────────────────────────────────────────────────┐
│                                                       │
│                                                       │
│              ╔══════════════════════╗                 │
│              ║  V  Vertebrae        ║                 │
│              ║─────────────────────║                 │
│              ║  Open a project      ║                 │
│              ║                      ║                 │
│              ║  Recent              ║                 │
│              ║  ─────────────────   ║                 │
│              ║  /home/user/acme  ›  ║                 │
│              ║  /home/user/blog  ›  ║                 │
│              ║                      ║                 │
│              ║  [+ Open directory]  ║                 │
│              ╚══════════════════════╝                 │
│                                                       │
└──────────────────────────────────────────────────────┘
```

**Card width:** 400px, centered vertically and horizontally.

**Recent projects:** Each row is clickable. On hover, shows a right-pointing chevron. Click immediately loads the project.

**"Open directory" button:** Opens the native OS file picker. Once selected, the project is added to recents and loaded immediately.

**Loading state:** After selecting, the card content briefly fades and shows a `Spinner` while the project loads.

**Empty state (first launch):** No "Recent" section. Just the button.

---

## 5. Operations

Operations is the home screen — the first thing you see after opening a project. It answers: *"What needs my attention and what is happening right now?"*

### 5.1 Layout

```
┌────┬─────────────────────────────────────────────────────┐
│    │  Operations                           ● 3 running   │
│ ⬡  ├─────────────────────────────────────────────────────┤
│    │                                                      │
│    │  ⚠ NEEDS ATTENTION                              2 ▾ │
│    │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  │
│    │  ●  Fix auth middleware     a1b2c3d4  ✗ Failed  2m  │
│    │  ●  Review PR output        e5f6g7h8  👁 Review  5m  │
│    │                                                      │
│    │  ▶ LIVE                                         1 ▾ │
│    │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  │
│    │  ⟳  Implement JWT service   i9j0k1l2  ⟳ Running 4m  │
│    │                                                      │
│    │  ✓ RECENTLY COMPLETED                           4 ▾ │
│    │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  │
│    │  ✓  Write unit tests        m3n4o5p6  ✓ Done   12m  │
│    │  ✓  Draft API spec          q7r8s9t0  ✓ Done   18m  │
│    │     [show 2 more]                                    │
│    │                                                      │
│    │  ○ READY                                        6 ▾ │
│    │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  │
│    │  ○  Add rate limiting       u1v2w3x4  In Review     │
│    │  ○  Write changelog         y5z6a7b8  Backlog       │
│    │     [show 4 more]                                    │
│    │                                                      │
└────┴─────────────────────────────────────────────────────┘
```

### 5.2 Section anatomy

Each section has:
- **Section header:** Category icon + label (uppercase, `text-xs` tracking-wider) + count badge + collapse chevron
- **Item rows:** below a `border-subtle` rule
- **"Show N more":** appears when section has > 3 items; expands inline on click

**Sections never have borders or cards** — they breathe through whitespace and the subtle dashed separator.

### 5.3 Item row anatomy

```
  ●  Fix auth middleware       a1b2c3d4   ✗ Failed   2m ago
  ↑  ↑─────────────────────   ↑───────   ↑────────  ↑─────
  │  Task title (text-base)   Identity   Status     Relative
  │                           (mono-sm)  badge      time
  │
  Priority dot (colored by priority: gray / blue / amber / red)
```

**Row height:** 36px.

**Hover:** Row background shifts to `interactive-hover`. On the right edge, `⋯` action menu appears (Run, Open Chat, View Trace, Delete).

**Click:** Opens the Task Detail Panel on the right. The row gets an `accent-subtle` left border highlight.

**Double-click / Cmd+click:** Opens in a pop-out window.

### 5.4 Section behavior

- **Needs Attention** (red dot icon): shows failed runs + tasks awaiting human review. Always listed first. If empty, the entire section collapses to nothing — no empty state, no heading.
- **Live** (spinning icon): shows tasks with active runs (executing, queued, waiting). Updates in real time — items animate in from top (slide-down + fade, 200ms) and fade out on completion.
- **Recently Completed** (checkmark icon): last 8 hours of completions, newest first. "Show N more" after 3.
- **Ready** (circle icon): tasks with no blockers, ready to run. Ordered by priority.

### 5.5 Live counter

The header's "● 3 running" badge:
- Green dot pulses when count > 0
- Count increments/decrements with a fade (no jarring flash)
- Disappears entirely when count reaches 0

### 5.6 Review gate surfaced inline

When a task is in the `pending_review` state, its row in Needs Attention shows an inline approve/reject affordance on hover:

```
  ●  Review PR output    e5f6g7h8  👁 Review  5m  [✓ Accept] [✗ Reject]
                                                   ↑──────────────────
                                                   appear on row hover
```

---

## 6. Board

The Board is the spatial map of work in flight. Columns = workflow steps. Cards = tasks.

### 6.1 Layout

```
┌────┬───────────────────────────────────────────────────────────┐
│    │  Board         [Epic] [Ticket ✓] [Task]      (search...)  │
│ ⊞  ├───────────────────────────────────────────────────────────┤
│    │                                                            │
│    │  ┌─ Backlog ─6 ─┐  ┌─ In Progress ─2 ─┐  ┌─ Review ─1 ─┐│
│    │  │               │  │                   │  │              ││
│    │  │ ┌───────────┐ │  │ ┌───────────────┐ │  │ ┌──────────┐││
│    │  │ │ Add rate   │ │  │ │ Implement JWT  │ │  │ │Review PR │││
│    │  │ │ limiting   │ │  │ │ service        │ │  │ │output    │││
│    │  │ │            │ │  │ │                │ │  │ │          │││
│    │  │ │ u1v2w3  ○ │ │  │ │ i9j0k1  ⟳     │ │  │ │ e5f6g7 👁│││
│    │  │ └───────────┘ │  │ └───────────────┘ │  │ └──────────┘││
│    │  │               │  │                   │  │              ││
│    │  │ ┌───────────┐ │  │ ┌───────────────┐ │  │              ││
│    │  │ │ Write      │ │  │ │ Update OpenAPI │ │  │              ││
│    │  │ │ changelog  │ │  │ │ schema         │ │  │              ││
│    │  │ │            │ │  │ │                │ │  │              ││
│    │  │ │ y5z6a7  ○ │ │  │ │ a2b3c4  ⟳     │ │  │              ││
│    │  │ └───────────┘ │  │ └───────────────┘ │  │              ││
│    │  │               │  │                   │  │              ││
│    │  └───────────────┘  └───────────────────┘  └──────────────┘│
│    │  ←──────────── horizontal scroll ──────────────────────────│
└────┴───────────────────────────────────────────────────────────┘
```

### 6.2 Column anatomy

**Column header:**
```
  │▓│  In Progress (AI ⚡)  ─ 2 ─────────────────────
  ↑
  2px left border in step type color (same vocabulary as pipeline nodes)
```
- 2px left border: `step-{type}-bar` color (indigo for AI, amber for Review, gray for Holding, green for Terminal)
- Step name in `text-sm` (500 weight)
- Type indicator: small type icon in `step-{type}-fg` color, shown after the step name
- Task count badge (pill shape, neutral)
- Header does not scroll — stays pinned when cards scroll within column

This color vocabulary is identical to the pipeline DAG, so users build one mental model that works in both views.

**Column width:** 240px fixed.  
**Column height:** fills viewport. Content scrolls within each column independently.  
**Column spacing:** 12px gap between columns.

### 6.3 Card anatomy

```
┌──────────────────────────────┐
│ Implement JWT service         │  ← title (text-sm, 500 weight)
│                               │
│ Implementation:In Progress    │  ← workflow:step label (text-xs, text-tertiary)
│ i9j0k1l2              ⟳ Run  │  ← ID (mono-sm) + status badge
└──────────────────────────────┘
```

**Card height:** auto, min 72px.  
**Card background:** `surface-elevated`.  
**Card border:** 1px `border-subtle`.  
**Selected card:** 2px `accent-default` border, `accent-subtle` tint.

**Hover behavior:**
- Background shifts up one surface level
- Subtle shadow (`elevation-1`) lifts the card
- `⋯` icon appears in top-right corner for quick actions

**Running state indicator:** A thin animated bar runs along the card's top edge, left-to-right, looping. Color: `status-info`.

**Failed state:** Left border (3px) in `status-error`.

**Review state:** Left border (3px) in `status-warning` + 👁 icon.

### 6.4 Filter bar

```
  [Epic] [Ticket ✓] [Task]      (🔍 Search tasks...)
```

- Level filters are `Chip` toggle buttons. Multiple can be active simultaneously.
- Search is a `SearchInput` — filters all visible cards by title/ID in real time.
- When filters are active, a "✕ Clear" link appears at the right edge.

### 6.5 Board + Detail Panel split

When a card is selected:

```
┌────┬──────────────────────────────┬─────────────────────┐
│    │  Board  [filters]  [search]   │  Implement JWT       │
│ ⊞  ├──────────────────────────────┤  i9j0k1l2  ⟳ Running│
│    │                               │─────────────────────│
│    │  ┌─ Backlog ─6 ──┐  ┌─ In P  │  Description         │
│    │  │               │  │   ←    │  ...                 │
│    │  │ ...           │  │ colum  │                      │
│    │  │               │  │  ns    │  [Acceptance Criteria]│
│    │  └───────────────┘  └────    │  [Code References]   │
│    │  ← columns compress →       │  [Dependencies]      │
└────┴──────────────────────────────┴─────────────────────┘
```

The board columns compress to accommodate the panel (not pushed off screen). Minimum column width collapses to 180px before horizontal scrolling begins.

---

## 7. Tasks

Tasks is the authoritative hierarchical view — every task, every level, fully browsable. This is the "raw list" view analogous to Linear's issue list.

### 7.1 Layout

```
┌────┬────────────────────────────────────────────────────────┐
│    │  Tasks                                      142 tasks  │
│ ≡  ├────────────────────────────────────────────────────────┤
│    │  (🔍 Search...)  [Level ▾]  [Step ▾]  [Tags ▾]  ⊞ ⊟  │
│    │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  │
│    │                                                         │
│    │  ▼ ◈  Refactor authentication system         a1b2c3d4 │
│    │    ▼ ◇  Implement JWT service                i9j0k1l2 │
│    │        ▷ ·  Create token signing function    m3n4o5p6 │
│    │        ▷ ·  Write JWT validation tests       q7r8s9t0 │
│    │        ▷ ·  Update middleware chain          u1v2w3x4 │
│    │    ▷ ◇  Update OpenAPI schema                a2b3c4d5 │
│    │    ▷ ◇  Write migration guide                e6f7g8h9 │
│    │                                                         │
│    │  ▷ ◈  Add rate limiting                      y5z6a7b8 │
│    │  ▷ ◈  Write changelog                        i0j1k2l3 │
│    │                                                         │
│    │  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌  │
│    │  142 tasks (38 epics · 61 tickets · 43 tasks)          │
└────┴────────────────────────────────────────────────────────┘
```

### 7.2 Tree row anatomy

```
  ▼ ◈  Refactor authentication system       Backlog   a1b2c3d4   2d ago
  ↑ ↑  ↑────────────────────────────────   ↑───────  ↑───────   ↑─────
  │ │  Title (text-base)                   Step      ID         Updated
  │ │                                      (text-xs) (mono-sm)  (rel)
  │ │
  │ Level icon: ◈ epic  ◇ ticket  · task
  │
  Expand chevron (▼ expanded, ▷ collapsed, nothing if leaf)
```

**Row height:** 32px.  
**Indent per level:** 20px.  
**Expand/collapse:** click the chevron, or press `→`/`←`.  
**Select:** click anywhere on the row except the chevron.

**Active run indicator:** When a task has a running execution, a faint spinning arc appears to the left of the level icon. No text — just the visual.

**Hover:** Background `interactive-hover`. On right edge: `⟳ Run` link appears (run the agent for this task).

### 7.3 Filter bar

The filter bar is a single horizontal row between the header and the list:

```
  (🔍 Search...)  [Level ▾]  [Step ▾]  [Tags ▾]    ⊞ expand all  ⊟ collapse all
```

- Search input: left-aligned, 220px width, grows on focus
- Filter dropdowns: open as floating panels, not inline
- "Expand all" / "Collapse all": icon buttons on right
- Active filters show as chips below the bar:

```
  Level: Ticket ×    Step: In Progress ×    + Add filter
```

### 7.4 Footer

```
  142 tasks · 38 epics · 61 tickets · 43 tasks
```

Shown in `text-xs` `text-tertiary`. When filters are active, it shows filtered count:

```
  12 of 142 tasks matching filters
```

---

## 8. Design

Design is the configuration screen. Users come here to set up workflows, steps, and agent configurations. This is an infrequent but powerful screen — optimized for clarity over speed.

### 8.1 Layout

```
┌────┬────────────────────────────────────────────────────────┐
│    │  Design                                                 │
│ ◈  ├────────────────────────────────────────────────────────┤
│    │                                                         │
│    │     ┌──── Implementation ────────────────────────────┐  │
│    │     │                                                  │  │
│    │     │   ┌─────────┐    ┌─────────┐    ┌───────────┐  │  │
│    │     │   │         │    │         │    │           │  │  │
│    │     │   │ Backlog │───▶│In Progr.│───▶│  Review   │  │  │
│    │     │   │   6 ○   │    │  2 ⟳    │    │   1 👁    │  │  │
│    │     │   │         │    │         │    │           │  │  │
│    │     │   └─────────┘    └─────────┘    └─────┬─────┘  │  │
│    │     │                                        │         │  │
│    │     │                           ┌────────────┘         │  │
│    │     │                           ▼                       │  │
│    │     │                    ┌─────────────┐               │  │
│    │     │                    │   Finished  │               │  │
│    │     │                    │     14 ✓    │               │  │
│    │     │                    └─────────────┘               │  │
│    │     └────────────────────────────────────────────────┘  │
│    │                                                         │
│    │     [zoom controls]     [fit to view]                   │
└────┴────────────────────────────────────────────────────────┘
```

### 8.2 Canvas

**Background:** Dot grid in `border-subtle` (1px dots, 20px spacing).

**Navigation:**
- Scroll to zoom (or pinch on trackpad)
- Click + drag on background to pan
- Double-click on background to fit-to-view (zoom reset)

**Toolbar (bottom-left of canvas):**
```
  [−]  75%  [+]     [⊞ fit]
```

### 8.3 Workflow zone

A workflow is rendered as a light background zone (rounded rect, `surface-elevated`) containing its steps. The zone has a title in the top-left corner.

**Click on zone background:** Selects the workflow, opens Workflow Detail Panel on the right.

### 8.4 Step node anatomy

Step nodes encode their type through a top accent bar and subtle background tint, creating a color vocabulary consistent with the Board view columns:

```
  ┌────────────────────────────────────────┐
  │████████████████████████████████████████│  ← 3px type bar (color by step type)
  ├────────────────────────────────────────┤
  │  In Progress                       ⚡  │  ← name (text-sm, 500) + type icon
  │                                        │
  │  2 tasks                    ⟳ 1 active│  ← task count + run state
  └────────────────────────────────────────┘
```

**Step type color encoding:**

| Step type | Bar color | Icon | Tint |
|-----------|-----------|------|------|
| AI (agent runs here) | Indigo `step-ai-bar` | ⚡ | Faint indigo |
| Review (human must act) | Amber `step-review-bar` | 👁 | Faint amber |
| Holding (passive queue) | Gray `step-holding-bar` | ⏸ | None |
| Terminal (end state) | Green `step-terminal-bar` | ✓ | Faint green |

**Node size:** 180px × 72px.

**Node states:**
- Default: `surface-elevated` + type tint + type bar
- Hover: bg one level lighter, `elevation-1` shadow, hover tooltip appears (400ms delay)
- Selected: `accent-default` 2px full border, `elevation-2` shadow, `NodeActionPopover` appears below (150ms delay)
- Executing: type bar pulses (opacity 100%→50%→100%, 1.5s loop)
- Failed: `status-error` 2px left border (stacks with top type bar)

**Click:** Selects step, opens Step Detail Panel (docked right). Both the docked panel and the `NodeActionPopover` are visible simultaneously.

### 8.5 Transition edges

```
  ┌─────────┐              ┌──────────────┐
  │ Backlog │ ────────────▶│  In Progress │
  └─────────┘  [condition] └──────────────┘
```

Edges are orthogonally routed. Labels appear on hover (transition condition text, if non-default). Clicking an edge selects it and shows the condition in a minimal right panel.

### 8.6 Canvas overlay panels

The Design view has three canvas overlays that float inside the canvas coordinate space (not docked to the right):

**NodeActionPopover** — appears below the selected node:
```
               ↕ 8px gap below selected node
  ┌────────────────────────────────────────────┐
  │  [▶ Run next task]  │  ✓ 14  ✗ 1  ⟳ 1    │
  └────────────────────────────────────────────┘
```
- `surface-overlay` background, `elevation-2` shadow, `radius-lg`
- Left: primary action (ghost button); Right: compact run summary
- When a run is active: "▶ Run next task" becomes "■ Stop run" + elapsed time

**LiveExecutionBanner** — floats at top of canvas when runs are active:
```
  ┌────────────────────────────────────────────────────────────┐
  │  ⟳  3 running  ·  In Progress (2)  ·  Review Gate (1)      │
  └────────────────────────────────────────────────────────────┘
```
- Pill shape, `surface-overlay`, centered horizontally, 12px from canvas top
- Step-name chips are clickable — flying the view to and flashing those nodes
- Auto-appears/disappears with runs

**CanvasMiniMap** — bottom-right of canvas (only when > 8 nodes):
- 160×100px, semi-transparent background
- Node dots colored by step type; drag to pan canvas

### 8.6 Creating and editing steps

**Adding a step to a workflow:**

1. Click the workflow zone background to select the workflow.
2. The Workflow Detail Panel opens on the right, listing current steps.
3. Scroll to the bottom of the step list → click "**+ Add step**".
4. A new step node animates onto the canvas (slides in from the right, 200ms).
5. The new node is auto-selected; its Step Detail Panel is open.
6. User types the step name inline.
7. User optionally configures the agent: model, instructions, tools.
8. Panel saves on blur.

**Connecting steps (adding a transition):**

1. Hover over the source step node → a small `+` connector dot appears on the node's right edge.
2. Click and drag from the `+` dot to the target step node.
3. An edge appears connecting the two nodes.
4. The edge is selected; a simple "Transition" panel appears on the right allowing optional condition text.

**Reordering steps:**
Steps in the DAG do not have a manual drag-to-reorder. Their position is determined by the ELK auto-layout algorithm based on transitions. Changing the step order means changing the transitions.

**Deleting a step:**
Right-click the node → "Delete step…" → confirmation modal. Only steps with zero tasks can be deleted.

---

## 9. Traces

Traces is the execution inspector — the "replay" view of what an agent did. It answers: *"What exactly happened when the agent ran?"*

### 9.1 Layout

```
┌────┬──────────────┬──────────────┬────────────────────────────┐
│    │  Tasks (40)  │  Runs         │  ← view mode: Thread/Time │
│    ├──────────────┤               │                            │
│ ⟳  │ (🔍 search) │  ┌──────────┐ │                            │
│    │              │  │ ⟳ Run 3  │ │  Implement JWT service     │
│    │ ▷ Refactor   │  │ 4m ago   │ │  Run 3  ·  4 minutes ago   │
│    │   auth       │  └──────────┘ │                            │
│    │   ↓          │  ┌──────────┐ │  ────────────────────────  │
│    │ ● Implement  │  │ ✓ Run 2  │ │                            │
│    │   JWT ←sel   │  │ 2h ago   │ │  [You]                     │
│    │   ↓          │  └──────────┘ │  Implement a JWT signing   │
│    │ ▷ Update     │  ┌──────────┐ │  service for the auth      │
│    │   OpenAPI    │  │ ✗ Run 1  │ │  middleware.               │
│    │              │  │ 1d ago   │ │                            │
│    │              │  └──────────┘ │  [Agent]                   │
│    │              │               │  I'll start by reading the │
│    │              │               │  existing middleware...    │
│    │              │               │  ┌──────────────────────┐ │
│    │              │               │  │ ▶ Read file          │ │
│    │              │               │  │   src/middleware.rs   │ │
│    │              │               │  └──────────────────────┘ │
│    │              │               │                            │
└────┴──────────────┴───────────────┴────────────────────────────┘
       ↑ Task rail    ↑ Run rail      ↑ Execution view (main area)
       200px          180px           fills remainder
```

### 9.2 Task rail

The left-most rail shows the task tree (same as the Tasks page, but compact). This is the task picker.

**Width:** 200px.  
**Row height:** 28px (tighter than Tasks page).  
**No filter bar** — just a search input at the top.

Clicking a task selects it and populates the Run rail.

### 9.3 Run rail

Shows the execution history for the selected task, newest first.

**Each run card:**
```
  ┌──────────────┐
  │ ⟳ Run 3      │  ← run number + status icon
  │ 4 min ago    │  ← relative time
  │ Step: Review │  ← which step ran
  └──────────────┘
```

**Status icons:** ⟳ running (animated), ✓ success, ✗ failed, 👁 review, ○ queued.

Clicking a run card loads it in the execution view. Selected run card has an `accent-default` left border.

### 9.4 Execution view

**View mode toggle** (in header):
```
  [Thread]  [Timeline]
```

#### Thread mode (default)

Renders the agent run as a conversation: user message (the task spec) followed by the agent's response, with tool calls expanded inline.

```
  ─── Step: Implementation · 4m ago ──────────────────────────

  ╔═══════════════════════════════════════════════════════════╗
  ║ [You]                                                     ║
  ║ Implement a JWT signing service...                        ║
  ╚═══════════════════════════════════════════════════════════╝

  ╔═══════════════════════════════════════════════════════════╗
  ║ [Agent · claude-sonnet-4-6]                               ║
  ║                                                           ║
  ║ I'll start by reading the existing middleware code...     ║
  ║                                                           ║
  ║ ┌ Read file ──────────────────────────────────────────┐  ║
  ║ │  src/auth/middleware.rs                              │  ║
  ║ │  [expand ▶]                                         │  ║
  ║ └──────────────────────────────────────────────────────┘  ║
  ║                                                           ║
  ║ The existing middleware uses session tokens. I'll now...  ║
  ╚═══════════════════════════════════════════════════════════╝
```

**User messages:** right-aligned, `accent-subtle` background.  
**Agent messages:** left-aligned, `surface-elevated` background.  
**Tool call blocks:** neutral background, expand inline on click. Show input params + result.

#### Timeline mode

Shows events as a horizontal timeline chart grouped by agent turn. Less detail, better for understanding flow and timing.

```
  Turn 1  ──────────────────────────────────────────────────
           [Read] [Read] [Write]  → result: success

  Turn 2  ──────────────────────────────────────────────────
           [Read] [Write] [Write] [Bash]  → result: success

  Turn 3  ──────────────────────────────────────────────────
           [Bash] [Write] [Bash]  → result: success
```

Each event is a small colored pill. Clicking a pill jumps to that event in Thread mode.

### 9.5 Active run controls

When the selected run is currently executing:
- The header shows a "■ Stop" button (right side)
- The last agent message in Thread mode shows a blinking cursor (streaming)
- The run rail card for the active run shows a slow pulse

### 9.6 Human review gate

When a run is in `pending_review`:
- A persistent banner appears at the top of the execution view (above the thread):

```
  ┌─────────────────────────────────────────────────────────┐
  │  👁  This run is awaiting your review.                   │
  │  The agent has completed the step and requests approval. │
  │                                                          │
  │  (Optional feedback for rejection...)                    │
  │                                        [Reject]  [Accept]│
  └─────────────────────────────────────────────────────────┘
```

- Banner background: `status-subtle-warning`
- Accept button: `primary` (accent)
- Reject button: `secondary`
- Rejection text field appears on "Reject" click before confirming

---

## 10. Task Detail Panel

The Task Detail Panel is the most-used surface in the application. It appears on the right side of any page when a task is selected, and must balance completeness with clarity.

### 10.1 Panel header

```
┌─────────────────────────────────────────────────────────────┐
│  Implement JWT service                         ⎋  ⧉  ⋯    │
│  i9j0k1l2  ·  Implementation:In Progress  ·  ⟳ Running    │
└─────────────────────────────────────────────────────────────┘
```

- Title: `text-lg` (500 weight), editable inline — click to activate, `Enter`/blur to save, `Escape` to cancel
- Second row: `IdentityBadge` + `·` separator + workflow:step badge + `·` separator + `StatusBadge`
- Top-right icons: ⎋ close, ⧉ detach to pop-out, ⋯ more actions (run, delete, open chat)

### 10.2 Panel sections (progressive disclosure)

Sections are always in this order. Each section is individually collapsible. Default state shown:

```
┌─────────────────────────────────────────────────────────────┐
│  Description                                          [edit] │
├─────────────────────────────────────────────────────────────┤
│  Implement a JWT signing service that replaces the          │
│  current session token approach in the auth middleware.     │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Acceptance Criteria                               3 of 5 ▾ │  ← expanded
├─────────────────────────────────────────────────────────────┤
│  [✓] JWT tokens must expire in 24h                          │
│  [✓] Refresh token flow implemented                         │
│  [ ] Unit tests for token validation                        │
│  [ ] Integration test with middleware                       │
│  [ ] Documentation updated                                  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Spec                                                   1 ▸ │  ← collapsed
├─────────────────────────────────────────────────────────────┤
│  Code References                                        2 ▸ │  ← collapsed
├─────────────────────────────────────────────────────────────┤
│  Dependencies                                           1 ▸ │  ← collapsed
├─────────────────────────────────────────────────────────────┤
│  Relations                                              3 ▸ │  ← collapsed
├─────────────────────────────────────────────────────────────┤
│  Metadata                                               ▸   │  ← collapsed
└─────────────────────────────────────────────────────────────┘
```

**Section collapse rules:**
- Description: always visible (no collapse)
- Acceptance Criteria: expanded if any items exist
- Spec, Code References, Dependencies, Relations: collapsed by default, count badge shown
- Metadata (dates, creator): collapsed by default — this is low-priority info

**Collapse animation:** height transition over 200ms, chevron rotates 90°.

### 10.3 Inline editing

Every text field in the panel is inline-editable:

1. **Rest state:** plain text, non-interactive cursor
2. **Hover:** subtle underline or background shift signals editability
3. **Click:** field activates, text becomes selectable/editable, cursor blinks
4. **Saving:** `Cmd+S` or blur after 500ms debounce
5. **Cancel:** `Escape` reverts to last saved value

No "Edit" mode toggle. No save/cancel button bar. The save is silent (no confirmation toast for routine saves; toast only on error).

### 10.4 Acceptance criteria checklist

```
  [✓]  JWT tokens must expire in 24h
  [ ]  Unit tests for token validation
  [ ]  Integration test with middleware        [+ add criterion]
```

- Checkbox click immediately marks the item done
- New criterion: click "+ add criterion" at bottom; inline text field appears; `Enter` to save, `Escape` to cancel
- Hover on existing item: shows `×` delete icon on right

### 10.5 Panel footer (action bar)

```
  [💬 Open Chat]    [▶ Run]    [⋯]
```

- **Open Chat:** opens a task-scoped chat session in the Chat Panel
- **Run:** triggers a run for this task (shows a spinner and transitions to `StatusBadge: Running`)
- **⋯ More:** reveals Delete, Archive (rare actions)

When the task is actively running, the Run button becomes:
```
  [■ Stop run]
```

### 10.6 Review gate in panel

When `pending_review`:

```
┌─────────────────────────────────────────────────────────────┐
│  ⚠ Awaiting your review                                      │
│  Run 3 completed and is requesting approval.                 │
│  View trace ›                                                │
│                                              [Reject] [Accept]│
└─────────────────────────────────────────────────────────────┘
```

This banner appears between the header and the first section. "View trace ›" is a link that opens the Traces page for this task.

---

## 11. Chat Panel

The Chat Panel is a floating surface for conversational interaction with the AI project assistant.

### 11.1 Appearance

```
                           ┌────────────────────────────────┐
                           │  Project Chat          ⧉  ×   │
                           ├────────────────────────────────┤
                           │                                │
                           │  I can help you manage tasks,  │
                           │  review agent work, or answer  │
                           │  questions about your project. │
                           │                                │
                           │  ────────────────────────────  │
                           │                                │
                           │  [You]                         │
                           │  What's the status of the auth │
                           │  refactor?                     │
                           │                                │
                           │  [Claude]                      │
                           │  The auth refactor has 3 tasks │
                           │  in progress:                  │
                           │  · Implement JWT service ⟳     │
                           │  · Update middleware chain ○   │
                           │  ...                           │
                           │                                │
                           ├────────────────────────────────┤
                           │  ▓▓▓▓▓▒▒▒▒▒░░░░░░░  12% used  │
                           │                                │
                           │  (Ask anything...)        [↵]  │
                           └────────────────────────────────┘
```

**Position:** anchored to bottom-right of viewport, 16px margin from edges.  
**Width:** 380px. **Min height:** 480px. Resizable from top edge.  
**Backdrop:** none (it's a floating panel, not a modal).

### 11.2 Scope indicator

When opened from a task's "Open Chat" button:

```
│  Task Chat: Implement JWT service      ⧉  ×  │
│  i9j0k1l2                                    │
```

The scope is shown in the header. The assistant has context about this specific task.

### 11.3 Context meter

A thin progress bar below the message list shows context window usage:

- 0–70%: green fill
- 70–90%: amber fill
- 90–100%: red fill

This helps the user understand when the conversation is approaching its limit without being alarming.

### 11.4 Multi-session tabs

When multiple chat sessions are open (e.g., project chat + task chat simultaneously):

```
│  [Project] [Implement JWT ×]          ⧉  ×  │
```

Tabs appear below the header. Clicking a tab switches to that session. Sessions do not interfere with each other.

### 11.5 Streaming

During response generation:
- "Send" button becomes "■ Stop"
- Text appends character-by-character
- A blinking cursor appears at the end of the streaming text
- The context meter updates in real time

---

## 12. Command Palette

The command palette is the universal shortcut for power users. It is the fastest path to any action in the system.

### 12.1 Invocation

`⌘K` (Mac) / `Ctrl+K` (Windows/Linux) from anywhere in the application.

`Escape` closes it. Clicking outside closes it.

### 12.2 Appearance

```
┌────────────────────────────────────────────────────────┐
│  🔍 (Search tasks, run commands...)                    │
├────────────────────────────────────────────────────────┤
│  Recent                                                │
│  ─────────────────────────────────────────────────    │
│  ●  Implement JWT service                  i9j0k1l2   │
│  ●  Fix auth middleware                    a1b2c3d4   │
│                                                        │
│  Actions                                               │
│  ─────────────────────────────────────────────────    │
│  ▶  Go to Operations                                   │
│  ▶  Go to Board                                        │
│  ▶  Go to Tasks                                        │
│     ─────────────────────────────────────────────     │
│  ⟳  Run task...                                       │
│  ◉  Switch project...                                  │
│  ◑  Toggle theme                           ⌘⇧D        │
└────────────────────────────────────────────────────────┘
```

**Width:** 520px, centered in the viewport.  
**Max height:** 400px, then scrolls.  
**Backdrop:** scrim at 40% opacity — keyboard navigation possible through the palette.

### 12.3 Search behavior

Typing in the input filters all categories simultaneously. Results are shown in ranked sections:

1. **Tasks** — fuzzy-matched by title and ID prefix
2. **Commands** — matched by keyword

```
┌────────────────────────────────────────────────────────┐
│  🔍 jwt                                                │
├────────────────────────────────────────────────────────┤
│  Tasks (3)                                             │
│  ─────────────────────────────────────────────────    │
│  ●  Implement JWT service               i9j0k1l2   ⟳  │
│  ●  Write JWT validation tests          q7r8s9t0   ○   │
│  ●  JWT refresh token flow              m4n5o6p7   ○   │
│                                                        │
│  Commands (1)                                          │
│  ─────────────────────────────────────────────────    │
│  ⟳  Run task: Implement JWT service                    │
└────────────────────────────────────────────────────────┘
```

The searched text is **bolded** in the result labels (not highlighted — bold, clean).

### 12.4 Keyboard navigation

- `↑` / `↓`: move selection through results
- `Enter`: execute selected action
- `Tab`: cycles between result sections
- `Escape`: close

The selection does not wrap around (hitting `↓` on the last item stops there). This prevents accidental actions.

### 12.5 Scoped commands

When the command palette is opened from within the Task Detail Panel, task-scoped actions are promoted to the top:

```
│  Context: Implement JWT service                        │
│  ─────────────────────────────────────────────────    │
│  ▶  Run this task                              ⌘↵     │
│  💬  Open task chat                                    │
│  ⧉  Detach to window                                   │
│  ✕  Delete task...                                     │
│  ─────────────────────────────────────────────────    │
│  Global actions...                                     │
```

---

## 13. Context Menus

Right-clicking any task (row, card, tree node) opens a context menu.

### 13.1 Task context menu

```
┌────────────────────────────────┐
│  Open detail                 ↵ │
│  Detach to window              │
│  Open chat                     │
├────────────────────────────────┤
│  Run task                  ⌘↵  │
│  View trace                    │
├────────────────────────────────┤
│  Archive task                  │
│  Delete task...                │
└────────────────────────────────┘
```

**Behavior:**
- Opens within 50ms of right-click (no delay)
- Positioned at cursor, avoiding viewport edges
- Closes on click outside, `Escape`, or any selection
- Dividers separate destructive actions (Archive, Delete) from primary actions
- "Delete" always has `...` suffix — it triggers a confirmation

### 13.2 Workflow step context menu (Design page)

Right-clicking a step node on the canvas:

```
┌────────────────────────────────┐
│  Edit step                     │
│  View tasks in step            │
├────────────────────────────────┤
│  Duplicate step                │
│  Delete step...                │
└────────────────────────────────┘
```

### 13.3 Run context menu (Traces — run rail)

Right-clicking a run card:

```
┌────────────────────────────────┐
│  View trace                  ↵ │
│  Re-run from this step         │
├────────────────────────────────┤
│  Copy run ID                   │
│  Export trace as JSON          │
└────────────────────────────────┘
```

---

## 14. Keyboard Shortcuts

All shortcuts are shown in the command palette. This is the canonical reference.

### 14.1 Global shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘K` | Open command palette |
| `⌘⇧D` | Toggle dark/light theme |
| `⌘1` | Go to Operations |
| `⌘2` | Go to Board |
| `⌘3` | Go to Design |
| `⌘4` | Go to Tasks |
| `⌘5` | Go to Traces |
| `⌘/` | Open project chat |
| `Escape` | Close panel / cancel / deselect |

### 14.2 List navigation (Tasks, Operations)

| Shortcut | Action |
|----------|--------|
| `↑` / `↓` | Move selection up/down |
| `→` | Expand tree node |
| `←` | Collapse tree node |
| `Enter` | Open selected item in detail panel |
| `⌘Enter` | Run selected task |
| `Space` | Toggle expand/collapse tree node |
| `/` | Focus search input |
| `⌘⇧E` | Expand all |
| `⌘⇧C` | Collapse all |

### 14.3 Detail panel shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘S` | Save current edit |
| `Escape` | Cancel edit / close panel |
| `⌘⇧O` | Detach to pop-out window |
| `⌘⇧T` | View trace for selected task |
| `⌘⌫` | Delete task (with confirmation) |

### 14.4 Traces shortcuts

| Shortcut | Action |
|----------|--------|
| `T` | Switch to Thread view |
| `L` | Switch to Timeline view |
| `⌘⌥↑` | Go to previous run |
| `⌘⌥↓` | Go to next run |
| `A` | Accept pending review |
| `R` | Reject pending review |

### 14.5 Shortcut discoverability

Shortcuts are shown next to their actions:
1. In the command palette (next to action labels)
2. In context menus (next to menu items)
3. In tooltips (in the tooltip for icon-only buttons where relevant)

There is no separate "Keyboard Shortcuts" settings panel — discoverability is inline.

---

## 15. User Journeys

### 15.1 Morning check-in (3 minutes)

*The user opens Vertebrae to see what happened overnight and what needs their attention.*

1. App opens to **Operations**.
2. The "Needs Attention" section has 2 items:
   - A failed run
   - A review request
3. User clicks the review request.
4. **Task Detail Panel** slides in from the right.
5. The review gate banner is at the top of the panel.
6. User clicks "View trace ›" to read what the agent produced.
7. **Traces page** opens with this task pre-selected and the most recent run loaded.
8. User reads through the Thread view — the agent's output looks correct.
9. User clicks the back arrow (or navigates back to Operations, panel is still selected).
10. User clicks **Accept** in the review gate.
11. The task's status transitions to the next workflow step. The panel updates. The item disappears from Needs Attention.

**Total clicks:** ~6. **Context switches:** 1 (to Traces, then back).

---

### 15.2 Understanding a failure (5 minutes)

*An agent run failed. The user needs to understand why.*

1. User sees a failed item in **Operations: Needs Attention**.
2. User clicks the row. **Task Detail Panel** opens.
3. StatusBadge shows "✗ Failed".
4. User clicks "View trace ›" link in the status area.
5. **Traces page** opens, task pre-selected, failed run pre-loaded.
6. Thread view shows the agent's output, ending with a tool call that failed.
7. User expands the failed ToolCallBlock.
8. Error message shows: compilation error in generated code.
9. User opens Chat Panel (bottom-right).
10. User asks: "The JWT implementation failed with a compilation error. Can you fix the issue in the generated code?"
11. Agent responds with analysis and suggestions.
12. User clicks **▶ Run** in the Task Detail Panel to re-run the step.

---

### 15.3 Reviewing the board before a standup (2 minutes)

*Quick glance at where work stands.*

1. User navigates to **Board**.
2. Level filter is set to "Ticket" (pre-set from last visit — filter state persists).
3. User sees 5 columns: Backlog (8), In Progress (3), Review (1), Done (14), Blocked (2).
4. User clicks a card in "Blocked" to understand the blocker.
5. Detail panel shows Dependencies section (expanded because there's an unresolved blocker).
6. User understands the situation and closes the panel.
7. Standup done.

---

### 15.4 Setting up a new workflow step (10 minutes)

*User wants to add a "Code Review" step between Implementation and Done.*

1. User navigates to **Design**.
2. User sees the existing workflow DAG.
3. User clicks on the "Implementation" zone.
4. **Workflow Detail Panel** opens.
5. User clicks "Add step".
6. A new step node appears on the canvas (animated, slides in from the right of the last step).
7. The step is selected automatically and its **Step Detail Panel** is open.
8. User types the step name: "Code Review".
9. User sets the agent config: model = claude-sonnet-4-6, instructions = "Review the produced code for correctness and best practices."
10. Step is saved on blur.
11. User drags the transition from "Implementation" to the new "Code Review" step — or selects the existing "Done" transition edge and rewires it through the new step.

---

### 15.5 Finding a specific task (30 seconds)

*User needs to find a task by name quickly.*

**Option A — via ⌘K:**
1. Press `⌘K` from anywhere.
2. Type the task name or ID prefix.
3. Results appear instantly. Press `Enter` to open.

**Option B — via Tasks:**
1. Navigate to Tasks.
2. Type in the Search input.
3. Tree filters in real time. Click the row.

---

## 16. Micro-interactions & Motion

### 16.1 List item state changes

When a task's status changes in real time (e.g., a run completes):

1. The `StatusBadge` content fades out (80ms)
2. The new status content fades in (80ms)
3. Simultaneously, the row background briefly flashes to `status-subtle-*` (120ms total flash cycle)

This creates a visible but non-jarring acknowledgment that something changed. The flash is subtle — users notice it without being startled.

### 16.2 New item appearing in Operations

When a new task enters a section (e.g., a new run starts and appears in "Live"):

- Item slides down from above while fading in (200ms, ease-out)
- Adjacent items reflow smoothly (height animation, 200ms)

When an item is completed and removed from a section:
- Item fades out (150ms) while its height collapses (150ms, slightly offset — fade slightly before height)
- This prevents the "disappearing floor" feeling

### 16.3 Panel open/close

- Open: panel slides in from right (200ms ease-out). Width animates from 0 to target.
- Close: panel slides out (150ms ease-in).
- While open, the main content area gently compresses (200ms).

### 16.4 Section expand/collapse

- Expand: height animates from 0 to full, content fades in (200ms)
- Collapse: height animates from full to 0, content fades out (150ms)
- Chevron rotates 90° simultaneously with the height animation

### 16.5 Streaming text

- Characters appear at approximately the natural reading pace for the model's output speed
- No cursor animation between bursts — just smooth character-by-character append
- When streaming ends, a subtle "completion" moment: the stop button fades out, the send button fades in (150ms)

### 16.6 Connection loss / recovery

- Loss: header right area transitions to warning state (150ms)
- Recovery: warning state fades out (300ms), replaced by nothing (success is silence)
- No toast notification for reconnection — it would be distracting

### 16.7 Hover reveals

All secondary actions (row-level `⋯`, checklist item delete `×`, card popover trigger) use the same reveal pattern:
- 0ms delay (instant — no hover delay)
- 150ms fade in
- 100ms fade out on mouse leave

This keeps the interface clean at rest while making actions feel immediately accessible.

---

## 17. Empty & Loading States

### 17.1 First load

When the application is loading data after a project is opened:

```
┌────┬─────────────────────────────────────────────────────┐
│    │  Operations                                          │
│    ├─────────────────────────────────────────────────────┤
│    │                                                      │
│    │  ████████████████████████████████░░░░░░   60px      │
│    │                                                      │
│    │  ████████████████████████████████░░░░░░   36px      │
│    │                                                      │
│    │  ████████████████████████████████░░░░░░   36px      │
│    │                                                      │
└────┴─────────────────────────────────────────────────────┘
```

Skeleton rows pulse with the shimmer animation. No spinner, no "Loading..." text. The skeleton's shape mimics the real content layout.

### 17.2 Empty Operations (quiet system)

When no tasks need attention and nothing is running:

```
│                                                      │
│                                                      │
│              ○  All clear                            │
│              No tasks need attention.                │
│                                                      │
│                                                      │
```

Minimal. One icon, one line of text. No illustration, no call to action — the system is healthy.

### 17.3 Empty Board (no tasks in any step)

```
│  ┌─ Backlog ─ 0 ─┐  ┌─ In Progress ─ 0 ─┐          │
│  │                │  │                    │          │
│  │  No tasks yet  │  │  No tasks yet      │          │
│  │                │  │                    │          │
│  └────────────────┘  └────────────────────┘          │
```

Each empty column shows one line of `text-tertiary` text.

### 17.4 Empty Tasks (no results for filter)

```
│                                                      │
│              (🔍)  No results                        │
│              No tasks match "jwt middleware".         │
│              [Clear filters]                         │
│                                                      │
```

The search query is echoed in the message. Single clear-filters action.

### 17.5 Traces — no run selected

```
│                                                      │
│  Select a task from the left to view its             │
│  execution history.                                  │
│                                                      │
```

Simple instructional text in `text-secondary`. No illustration.

### 17.6 First launch (no projects)

As described in Section 4. Welcoming but not overdesigned.

---

## 18. Responsive & Focus Modes

### 18.1 Narrow viewport (< 900px)

The application is a desktop tool. Below 900px width:
- The Board page replaces horizontal scroll with a single-column view (one step visible at a time, tabs at top)
- The Tasks page hides the metadata columns (ID, Updated) from rows
- Detail panel is full-width (covers main content) rather than side-by-side

### 18.2 Pop-out windows

Pop-out windows (task detail, chat, traces) are designed for focused work:
- No sidebar
- Slim title bar: entity name + type badge + close button
- Full-height content
- Always-on-top optional (user preference)
- Inherit the current theme

### 18.3 Full-screen trace view

Double-clicking the Traces page "expand" affordance enters a full-window trace inspector — all rails visible, maximum reading space. This is the deep-dive mode for long-running agent executions.

---

## 19. Settings

Settings are accessed via `⌘,` (standard on macOS/most desktop apps) or via the `⋯` menu in the sidebar. They are shown as a modal dialog (not a full page), reinforcing that settings are infrequent and peripheral.

### 19.1 Layout

```
┌─────────────────────────────────────────────────────────┐
│  Settings                                           ×   │
├─────────────────┬───────────────────────────────────────┤
│                 │                                        │
│  General        │  General                              │
│  Notifications  │  ──────────────────────────────────   │
│  Connection     │  Theme                                │
│                 │  [Dark  ●  Light  ○]                  │
│                 │                                        │
│                 │  Show styleguide in sidebar            │
│                 │  [off ○]                              │
│                 │                                        │
└─────────────────┴───────────────────────────────────────┘
```

**Tabs (left sidebar in modal):** General, Notifications, Connection.

### 19.2 General settings

| Setting | Type | Default |
|---------|------|---------|
| Theme | Segmented: Dark / Light / System | System |
| Show styleguide in sidebar | Toggle | off |
| Confirm before deleting tasks | Toggle | on |

### 19.3 Notification settings

| Setting | Type | Default |
|---------|------|---------|
| Run failed | Toggle | on |
| Pending review | Toggle | on |
| Run completed | Toggle | off |
| Play sound | Toggle | off |

### 19.4 Connection settings

| Setting | Type | Default |
|---------|------|---------|
| Daemon URL | Text input | `http://localhost:4747` |
| Connection status | Read-only badge | — |
| [Test connection] | Button | — |

Changing the daemon URL requires a reconnect. Clicking "Test connection" shows a `Spinner` then a success/error `Badge` inline.

---

*End of Vertebrae UX Specification v1.0*
