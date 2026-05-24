# Vertebrae Design System — Refinements

> Addendum to ui_designer_goal.md and ux_specification.md  
> Covers: project identity, step-type visual language, pipeline canvas panels

---

## 1. Project Identity

### 1.1 The problem

The application manages multiple projects. The current spec places a project-switcher icon at the top of the sidebar, but icon-only at 48px provides no persistent confirmation of which project is loaded. A user who has multiple projects could lose track of context.

### 1.2 Solution: breadcrumb header + window title

**Window title bar (OS level):**
```
myproject — Vertebrae
```

The OS window title always names the active project. This is the always-visible anchor.

**Page header — breadcrumb format:**
```
┌─────────────────────────────────────────────────────┐
│  myproject  ›  Operations                 ● 3 running│
└─────────────────────────────────────────────────────┘
```

The project name is rendered as a breadcrumb prefix:
- `myproject` — `text-sm` weight-400, `text-tertiary` color
- `›` separator — `text-tertiary`, reduced opacity
- `Operations` — `text-xl` weight-600, `text-primary` color

All three are on the same baseline. The project name is not a link (clicking it opens the project switcher popover in the sidebar, not page navigation).

**Why this works:**
- No additional layout space consumed (the header is 48px regardless)
- Project context is visually subordinate to the current page — it's ambient information, not a distraction
- Linear uses the same pattern: team name appears above the section title in their sidebar, we adapt it into the header breadcrumb

### 1.3 Sidebar project switcher (refined)

```
┌────┐
│ V  │  ← Logo mark (10px padding, 28px mark)
├────┤
│ █P │  ← Project avatar: 28px square, rounded-md
│ ▾  │    background: hashed from project name → one of 8 accent shades
└────┘    letter: first char of project name, white, mono font
```

**Project avatar color hashing:**
Rather than the user choosing a color, the avatar background is deterministically derived from the project name hash. This produces consistent colors across sessions without requiring setup. 8 possible colors are drawn from the accent, success, warning, info, and two neutral shades:

| Bucket | Background | Sample |
|--------|-----------|--------|
| 0 | `accent-700` (indigo) | V |
| 1 | `green-600` | A |
| 2 | `amber-600` | B |
| 3 | `blue-600` | C |
| 4 | `red-700` | D |
| 5 | `accent-800` (deep indigo) | E |
| 6 | `green-700` | F |
| 7 | `gray-600` | G |

**Hover state:** tooltip appears showing full project path (`/home/user/myproject`).

**Click:** Opens a popover showing:
```
┌──────────────────────────────────┐
│  █P  myproject                ✓  │  ← current, checkmark
├──────────────────────────────────┤
│  █A  acme                        │
│  █B  blog                        │
├──────────────────────────────────┤
│  + Open directory...             │
└──────────────────────────────────┘
```

Width: 220px. Anchors to the left edge of the sidebar, top-aligned with the project avatar.

---

## 2. Step Type Semantic Color System

### 2.1 Why step types need color

In a workflow DAG, not all steps are the same kind of activity:
- Some steps run AI agents autonomously
- Some steps pause and wait for a human to review
- Some are passive holding areas (backlog, queue)
- Some are terminal states (done, archived)

These four **step characters** need distinct visual treatments so the user can read the pipeline's structure at a glance — without reading every label.

### 2.2 The four step types

| Type | Token | Meaning | Visual cue |
|------|-------|---------|------------|
| **AI** | `step-ai` | An agent executes here | Indigo accent |
| **Review** | `step-review` | Human must act here | Amber |
| **Holding** | `step-holding` | Passive queue, no action | Neutral gray |
| **Terminal** | `step-terminal` | End state, work is done | Green |

These cover all current step types in Vertebrae. If a step type is not explicitly classified, it defaults to **Holding** (gray = neutral, no assumption).

### 2.3 Color tokens (extends Section 2 of ui_designer_goal.md)

**Dark theme additions:**

```
step-ai-bar:        accent-500  (#6655EE)     ← 3px node top bar
step-ai-subtle:     accent-900  at 50%        ← faint node tint
step-ai-fg:         accent-300  (#9B8EF8)     ← text on tinted background

step-review-bar:    amber-500   (#D97B1A)
step-review-subtle: amber-900   at 50%
step-review-fg:     amber-300   (#FBB962)

step-holding-bar:   gray-600    (#3A3A44)
step-holding-subtle: transparent              ← no tint, default bg
step-holding-fg:    gray-400    (#8A8A9A)

step-terminal-bar:  green-500   (#2D9E55)
step-terminal-subtle: green-900  at 50%
step-terminal-fg:   green-300   (#72DCA0)
```

**Light theme additions:**

```
step-ai-bar:        accent-600  (#5544CC)
step-ai-subtle:     accent-200  at 40%
step-ai-fg:         accent-700  (#3D2D9E)

step-review-bar:    amber-600   (#B56B10)
step-review-subtle: amber-100   at 60%
step-review-fg:     amber-700   (#8C4B00)

step-holding-bar:   gray-400    (#9A9AA6)
step-holding-subtle: transparent
step-holding-fg:    gray-600    (#636370)

step-terminal-bar:  green-600   (#1E7A40)
step-terminal-subtle: green-100  at 60%
step-terminal-fg:   green-700   (#155730)
```

### 2.4 Visual treatment on WorkflowNode

The step type is shown through two visual elements:

**a) Top accent bar (3px)**
A horizontal bar across the full width of the node's top edge, using `step-{type}-bar`. This is the primary type indicator — visible at any zoom level.

**b) Type icon (top-right corner)**
A small 14px icon in the node's top-right corner, color `step-{type}-fg`:

| Type | Icon | Label |
|------|------|-------|
| AI | ⚡ (lightning) | Agent |
| Review | 👁 (eye) | Review |
| Holding | ⏸ (pause) | — |
| Terminal | ✓ (check) | Done |

**WorkflowNode anatomy (updated):**

```
┌─────────────────────────────────────────────────────┐
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  ← 3px bar (step type color)
├─────────────────────────────────────────────────────┤
│  In Progress                                    ⚡  │  ← name + type icon
│                                                      │
│  2 tasks                              ⟳  1 running  │  ← task count + run state
└─────────────────────────────────────────────────────┘
```

Node dimensions: 180px × 72px (slightly wider than original 160px to accommodate the layout).

**Node states (layered):**

| State | Effect |
|-------|--------|
| Default | `surface-elevated` bg, `border-default` border |
| Type tint | `step-{type}-subtle` bg overlay (always on if type is AI/Review/Terminal) |
| Hover | bg shifts one level lighter, `elevation-1` shadow appears |
| Selected | `accent-default` 2px full border, `elevation-2` shadow |
| Executing | top bar pulses (opacity 100% → 50% → 100%, 1.5s loop) |
| Failed | `status-error` 2px border on left edge (in addition to type bar) |

**Example nodes by type:**

```
AI step (dark theme):
┌──────────────────────────┐
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  indigo bar
│  In Progress         ⚡  │  faint indigo bg tint
│  2 tasks  ⟳ 1           │
└──────────────────────────┘

Review step (dark theme):
┌──────────────────────────┐
│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│  amber bar
│  Review Gate         👁  │  faint amber bg tint
│  1 task   👁 1           │
└──────────────────────────┘

Holding step (dark theme):
┌──────────────────────────┐
│░░░░░░░░░░░░░░░░░░░░░░░░░│  gray bar (subtle)
│  Backlog             ⏸  │  no background tint
│  6 tasks             ○  │
└──────────────────────────┘

Terminal step (dark theme):
┌──────────────────────────┐
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│  green bar
│  Done                ✓  │  faint green bg tint
│  14 tasks            ✓  │
└──────────────────────────┘
```

### 2.5 Color in the Board view (KanbanColumn header)

Step type color extends to the Board view. Each column header shows a thin left border in the step type color:

```
│2px│  In Progress ─ 2 ────────────────────────────────
(indigo)

│2px│  Review Gate ─ 1 ────────────────────────────────
(amber)

│2px│  Backlog ─ 6 ─────────────────────────────────────
(gray)

│2px│  Done ─ 14 ────────────────────────────────────────
(green)
```

This creates a consistent visual vocabulary: the same color means the same step type, whether you're looking at the pipeline (Design) or the board (Board).

### 2.6 Step type in the sidebar Operations page

In Operations, task rows can optionally show a small type-colored dot:

```
  ⚡  Implement JWT service     a1b2c3d4   ⟳ Running   4m
  👁  Review PR output           e5f6g7h8   👁 Review    5m
```

The type icon replaces the generic priority dot when the step type is contextually useful. For the "Live" and "Needs Attention" sections, this helps the user understand what kind of step needs their attention at a glance.

---

## 3. Pipeline Canvas: Floating Panels & Overlays

### 3.1 Mental model

The Design/pipeline view has two layers of UI:

**Layer 1 — Docked panel** (right side, outside the canvas)
The `DetailPanel` for step/workflow configuration. Opens when a node or workflow zone is selected. Consistent with all other pages. The canvas slightly compresses to accommodate it.

**Layer 2 — Canvas overlays** (floating, inside the canvas)
UI elements that live within the canvas coordinate space. These provide at-a-glance information and quick actions without requiring the user to look away from the diagram.

These two layers must not conflict. The docked panel handles configuration; canvas overlays handle awareness and quick actions.

### 3.2 Node action popover

When a step node is selected, a compact floating panel appears anchored below (or above if near the viewport bottom) the selected node.

```
                   ┌────────────────────────┐
                   │  In Progress       ⚡  │  ← selected node
                   │  2 tasks  ⟳ 1          │
                   └────────────────────────┘
                            ↕ 8px
            ┌───────────────────────────────────────┐
            │  [▶ Run next task]  ·  ✓ 14  ✗ 1  ⟳ 1 │
            └───────────────────────────────────────┘
```

**Anatomy:**
- Width: 240px (wider than node to show run summary)
- Height: 36px (single row)
- Background: `surface-overlay`, `elevation-2` shadow, `radius-lg`
- Left: primary action button ("▶ Run next task" — `ghost` variant, compact)
- Separator: `border-subtle` vertical 1px
- Right: compact run summary (✓ completed · ✗ failed · ⟳ running, each with count)

**Positioning:**
- Centered horizontally relative to the node
- 8px gap below the node bottom edge
- Flips to above the node if < 80px below the viewport bottom
- Does not follow the node when the canvas is panned (it moves with the canvas coordinate space)

**Lifecycle:**
- Appears 150ms after node selection (brief delay avoids flash when clicking through nodes)
- Disappears immediately when: node deselected, canvas pan starts, `Escape` pressed
- Remains visible while the docked `DetailPanel` is open

**When the node has a running execution:**
```
            ┌─────────────────────────────────────────────────┐
            │  [■ Stop run]  ·  ⟳ running · 0:47 elapsed     │
            └─────────────────────────────────────────────────┘
```

The action and summary update live without the popover closing.

### 3.3 Live execution banner

When any tasks are currently running, a floating status banner appears at the top of the canvas area.

```
Canvas:
┌──────────────────────────────────────────────────────────────┐
│                                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ⟳  3 running  ·  In Progress (2)  ·  Review Gate (1) │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                               │
│   [workflow nodes...]                                         │
└──────────────────────────────────────────────────────────────┘
```

**Anatomy:**
- Positioned: 12px from the canvas top edge, centered horizontally
- Background: `surface-overlay`, `elevation-2` shadow, `radius-full` (pill shape)
- Height: 32px
- Left: ⟳ spinning icon + "N running" count
- Divider: `·` separator
- Right: per-step running counts as clickable chips

**Step chip behavior:**
Clicking "In Progress (2)" triggers a canvas fly-to: the view pans and zooms to show all In Progress nodes, which briefly flash their border (200ms accent flash) to indicate which ones are active.

**Lifecycle:**
- Appears (slides down 8px + fade in, 200ms) when first run starts
- Count updates in real time
- Disappears (fades out, 150ms) 2 seconds after the last active run completes
- Never appears when no runs are active

### 3.4 Mini-map

A small overview map appears in the bottom-right corner of the canvas for large pipelines (more than 8 nodes).

```
Canvas:
┌──────────────────────────────────────────────────────────────┐
│   [workflow nodes...]                                         │
│                                                               │
│                                                    ┌────────┐│
│                                                    │ ╔══╗   ││  ← viewport rect
│                                                    │ ║  ║   ││
│                                                    │ ╚══╝   ││
│                                                    │ ·  · · ││  ← node dots
│                                                    └────────┘│
└──────────────────────────────────────────────────────────────┘
```

**Anatomy:**
- Size: 160px × 100px
- Background: `surface-overlay` at 80% opacity, `elevation-2` shadow, `radius-md`
- Viewport rectangle: `accent-default` at 30% opacity with 1px `accent-default` border
- Node dots: colored by step type using `step-{type}-bar` colors
- Transition edges: 1px `border-subtle` lines between dots

**Behavior:**
- Hidden when there are ≤ 8 nodes (the full canvas fits in view at default zoom)
- Click + drag within the mini-map: pans the main canvas view
- Clicking a node dot: centers the main view on that node

### 3.5 Hover tooltip on nodes

Before a node is selected (hover only), a compact tooltip appears near the cursor:

```
  Cursor hovers over node...
  
  ┌────────────────────────────────────────┐
  │  In Progress  [⚡ AI]                  │  ← name + type badge
  │  2 active · 14 done · 1 failed        │  ← task summary
  │  Last run: 4 min ago · by JWT task    │  ← recency
  └────────────────────────────────────────┘
```

**Anatomy:**
- Width: 240px max
- Background: `surface-overlay`, `elevation-2`, `radius-md`
- Appears after 400ms hover (standard Tooltip delay)
- Positioned: 12px to the right of the cursor, or left if near the right viewport edge
- Never overlaps the cursor position (always offset)

This tooltip is dismissed on:
- Mouse leaving the node
- Mouse click (which opens the node action popover instead)

---

## 4. Updated Component Descriptions

### 4.1 WorkflowNode (updated)

**What it is:** A node in the workflow DAG diagram. Represents one step in a workflow, with its type visually encoded through color.

**Structure:**
- Top accent bar (3px): step type color (`step-{type}-bar`)
- Node body: step name (left) + type icon (right, 14px)
- Node footer: task count (left) + run state badge (right)
- Optional background tint: `step-{type}-subtle` for AI, Review, and Terminal types

**Step types and their visual treatment:**

| Type | Bar color | Icon | Background tint |
|------|-----------|------|----------------|
| AI | Indigo accent | ⚡ | Faint indigo |
| Review | Amber | 👁 | Faint amber |
| Holding | Gray | ⏸ | None |
| Terminal | Green | ✓ | Faint green |

**States:**
- Default: `surface-elevated` bg + type tint + type bar
- Hover: lighter bg, `elevation-1` shadow, cursor pointer
- Selected: `accent-default` 2px border (all sides), `elevation-2` shadow
- Executing: type bar pulses (opacity 100→50→100%, 1.5s loop)
- Failed: `status-error` 2px left border (stacks with type bar at top)

**Canvas overlays triggered by this node:**
- On hover (400ms delay): hover tooltip
- On select (150ms delay): node action popover (floats below)
- When executing: contributes to the live execution banner

### 4.2 KanbanColumn (updated)

Columns now include a step-type left border to extend the pipeline's visual vocabulary into the board view. The column header shows:

```
│2px│  In Progress (AI ⚡)  ─ 2 ─────────────────────
      ↑ type border    ↑ type indicator text (optional, tiny)
```

The step type indicator text is optional — shown when the column's step type label is not obvious from the step name alone.

### 4.3 Header (updated)

The page header now supports a breadcrumb prefix for project context:

**Structure:**
- Left: `[project-name] › [Page Title]`
  - Project name: `text-sm` weight-400, `text-tertiary`
  - Separator `›`: `text-tertiary` at 50% opacity
  - Page title: `text-xl` weight-600, `text-primary`
- Right: contextual info (live count, filters, etc.) — unchanged

**When no project is loaded** (Setup page): the breadcrumb prefix is absent. The header shows only the app name `Vertebrae` in `text-xl`.

---

## 5. Revised Shell Layout

### 5.1 Sidebar with project avatar (revised Section 3.1)

```
┌────┐
│    │  4px padding
│ V  │  ← Vertebrae logo mark (28px, centered in 48px column)
│    │  4px padding
├────┤  1px border-subtle
│    │  6px padding
│ █P │  ← Project avatar (28px × 28px, radius-md)
│ ▾  │  ← dropdown chevron (8px below avatar)
│    │  6px padding
├────┤  1px border-subtle
│    │  8px padding
│ ⬡  │  ← Operations   [⬤ if needs attention]
│ ⊞  │  ← Board
│ ◈  │  ← Design
│    │  ─ divider
│ ≡  │  ← Tasks
│ ⟳  │  ← Traces
│    │  flex-grow
│ 💬 │  ← Project Chat
│ ◑  │  ← Theme toggle
└────┘
```

**Notification dot on Operations icon:**
A 6px filled circle in `status-error` appears to the upper-right of the Operations icon whenever there are tasks needing attention (failed runs or pending reviews). It has no number — presence alone signals "look here." The dot disappears when the Needs Attention section is empty.

### 5.2 Project avatar states

| State | Appearance |
|-------|-----------|
| Default | Colored square (hashed color), first-letter monogram, white |
| Hover | Tooltip: full project path + dropdown arrow brightens |
| Active (popover open) | `accent-subtle` background ring around the avatar |
| Loading (switching projects) | Spinner overlay on the avatar (200ms fade in) |

---

## 6. Summary of Additions

This document adds the following to the design system:

**New semantic tokens (8 per theme):**
`step-ai-bar`, `step-ai-subtle`, `step-ai-fg`  
`step-review-bar`, `step-review-subtle`, `step-review-fg`  
`step-holding-bar`, `step-holding-subtle`, `step-holding-fg`  
`step-terminal-bar`, `step-terminal-subtle`, `step-terminal-fg`

**New canvas overlay components (3):**
- **NodeActionPopover** — floating quick-action panel anchored to selected node
- **LiveExecutionBanner** — floating pill showing active run count by step
- **CanvasMiniMap** — overview navigation for large pipelines

**Refined existing components (3):**
- `WorkflowNode` — now includes type bar, type icon, type tint, and triggers canvas overlays
- `KanbanColumn` — now includes step-type left border
- `Header` — now includes project breadcrumb prefix

**Project identity (new):**
- Window title: `[project] — Vertebrae`
- Header breadcrumb: `project › Page`
- Sidebar project avatar with color hashing + hover popover

---

*End of Design Refinements v1.0*
