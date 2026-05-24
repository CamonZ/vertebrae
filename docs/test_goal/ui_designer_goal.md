# Vertebrae Design System

> A minimal, elegant interface for AI workflow orchestration and task management.  
> Version 1.0 — Design Language Specification

---

## Table of Contents

1. [Design Philosophy](#1-design-philosophy)
2. [Design Tokens](#2-design-tokens)
3. [Themes](#3-themes)
4. [Component Catalog](#4-component-catalog)
   - [Atoms](#atoms)
   - [Molecules](#molecules)
   - [Organisms](#organisms)
   - [Page Templates](#page-templates)
5. [Interaction Patterns](#5-interaction-patterns)
6. [Pages](#6-pages)

---

## 1. Design Philosophy

Vertebrae is a professional tool for engineers and technical teams orchestrating AI agents. The interface must communicate system state at a glance, allow rapid action, and stay out of the way when focused work demands attention.

### Core Principles

**1. Density with breathing room**  
Professional tools are dense. Pack maximum information into the viewport without crowding. Achieve breathing room through consistent whitespace rhythm, not large empty areas.

**2. Monochrome first**  
Color is reserved for meaning: semantic status (success, warning, error, active). Everything structural — borders, backgrounds, dividers — uses neutral grays. The accent color appears only for interactive or selected states.

**3. Hierarchy through weight, not decoration**  
Visual hierarchy is expressed through typographic weight and contrast, not borders, boxes, or shadows. Surfaces are separated by value shifts, not strokes.

**4. Motion as meaning**  
Animation is used only when it conveys information: a streaming response building, a task transitioning state, a panel sliding in. No decorative animations. Durations are short (120–200ms) and easing is ease-out.

**5. Persistent context**  
The application always shows the user what is happening in the background. Running tasks, live streams, and connection state are always visible, never hidden behind navigating away.

**6. Keyboard-first with mouse support**  
Every action is reachable by keyboard. Pointer interactions confirm, not replace, keyboard flows.

---

## 2. Design Tokens

Tokens are the primitive variables of the design system. All component styles reference tokens, never raw values.

### 2.1 Color Primitives

These are the raw color values. Components never reference primitives directly — they reference semantic tokens.

```
Neutral
  gray-50:   hsl(240, 10%, 98%)
  gray-100:  hsl(240, 8%, 95%)
  gray-200:  hsl(240, 5%, 88%)
  gray-300:  hsl(240, 5%, 75%)
  gray-400:  hsl(240, 5%, 58%)
  gray-500:  hsl(240, 5%, 42%)
  gray-600:  hsl(240, 5%, 28%)
  gray-700:  hsl(240, 5%, 18%)
  gray-800:  hsl(240, 5%, 12%)
  gray-850:  hsl(240, 5%, 9%)
  gray-900:  hsl(240, 6%, 6%)
  gray-950:  hsl(240, 8%, 4%)

Accent (Indigo)
  accent-200: hsl(248, 60%, 88%)
  accent-300: hsl(248, 60%, 78%)
  accent-400: hsl(248, 65%, 68%)
  accent-500: hsl(248, 68%, 60%)  ← primary accent
  accent-600: hsl(248, 65%, 50%)
  accent-700: hsl(248, 55%, 35%)
  accent-800: hsl(248, 45%, 22%)
  accent-900: hsl(248, 35%, 14%)

Success (Green)
  green-400: hsl(142, 60%, 55%)
  green-500: hsl(142, 55%, 42%)
  green-600: hsl(142, 55%, 32%)
  green-900: hsl(142, 40%, 14%)

Warning (Amber)
  amber-400: hsl(32, 90%, 62%)
  amber-500: hsl(32, 85%, 50%)
  amber-600: hsl(32, 80%, 38%)
  amber-900: hsl(32, 55%, 16%)

Error (Red)
  red-400: hsl(0, 75%, 65%)
  red-500: hsl(0, 70%, 52%)
  red-600: hsl(0, 65%, 40%)
  red-900: hsl(0, 50%, 16%)

Info (Blue)
  blue-400: hsl(210, 75%, 62%)
  blue-500: hsl(210, 70%, 48%)
  blue-600: hsl(210, 65%, 36%)
  blue-900: hsl(210, 45%, 16%)
```

### 2.2 Semantic Color Tokens

These are the tokens that components use. They map to primitives and switch between themes.

```
Surfaces
  surface-base        Background of the app window (darkest)
  surface-default     Most common background (cards, panels)
  surface-elevated    Raised surfaces (modals, popovers)
  surface-overlay     Overlay surfaces (dropdowns, tooltips)

Borders
  border-subtle       Barely visible separator (row dividers)
  border-default      Standard border (cards, inputs)
  border-strong       Emphasized border (focused input, selected state)

Text
  text-primary        Highest contrast body text
  text-secondary      Supporting / metadata text
  text-tertiary       Placeholder / disabled / label text
  text-inverse        Text on colored backgrounds (badge labels)
  text-accent         Accent-colored text (links, active states)

Accent
  accent-default      Primary accent color
  accent-hover        Accent on hover
  accent-subtle       Low-opacity accent background (selected row tint)
  accent-fg           Foreground on accent backgrounds

Status
  status-success      Green: completed, healthy
  status-warning      Amber: needs attention, degraded
  status-error        Red: failed, critical
  status-info         Blue: informational, in-progress
  status-subtle-*     Muted background variants for each status

Interactive
  interactive-default   Default state of interactive elements
  interactive-hover     Hover state
  interactive-active    Pressed state
  interactive-disabled  Disabled state
```

### 2.3 Typography

**Typefaces**

| Role      | Stack                                               |
|-----------|-----------------------------------------------------|
| UI        | `system-ui, -apple-system, "Segoe UI", sans-serif`  |
| Monospace | `"JetBrains Mono", "SF Mono", "Cascadia Code", monospace` |

**Type Scale**

| Token       | Size | Weight | Line Height | Use                              |
|-------------|------|--------|-------------|----------------------------------|
| `text-2xl`  | 24px | 600    | 1.2         | Page headings                    |
| `text-xl`   | 20px | 600    | 1.2         | Section headings                 |
| `text-lg`   | 16px | 500    | 1.4         | Panel titles, emphasis           |
| `text-base` | 14px | 400    | 1.5         | Body text, default               |
| `text-sm`   | 13px | 400    | 1.4         | Secondary text, labels           |
| `text-xs`   | 11px | 500    | 1.3         | Badges, timestamps, metadata     |
| `mono-base` | 13px | 400    | 1.5         | IDs, code, file paths            |
| `mono-sm`   | 11px | 400    | 1.4         | Inline IDs in dense contexts     |

### 2.4 Spacing

4px base unit. All spacing values are multiples.

```
space-1:   4px
space-2:   8px
space-3:   12px
space-4:   16px
space-5:   20px
space-6:   24px
space-8:   32px
space-10:  40px
space-12:  48px
space-16:  64px
```

### 2.5 Border Radius

```
radius-sm:  4px   Chips, badges, small elements
radius-md:  6px   Buttons, inputs, cards
radius-lg:  8px   Panels, modals
radius-xl:  12px  Large cards, floating surfaces
radius-full: 9999px  Circular elements
```

### 2.6 Elevation (Shadow)

Dark theme relies on background value shifts rather than shadows. Light theme uses subtle shadows.

```
elevation-0: none                 (flat, no shadow)
elevation-1: 0 1px 3px rgba(0,0,0,0.12)    (cards)
elevation-2: 0 4px 12px rgba(0,0,0,0.15)   (panels, popovers)
elevation-3: 0 8px 24px rgba(0,0,0,0.20)   (modals)
```

### 2.7 Motion

```
duration-instant: 0ms
duration-fast:   120ms  (hover transitions, micro-interactions)
duration-base:   200ms  (panel slides, modal entry)
duration-slow:   300ms  (page transitions)

easing-default: cubic-bezier(0.16, 1, 0.3, 1)   (ease-out, snappy)
easing-linear:  linear                            (progress bars, streaming)
```

---

## 3. Themes

### 3.1 Dark Theme (Default)

```
surface-base:       gray-950  (#0A0A0E)
surface-default:    gray-900  (#0E0E12)
surface-elevated:   gray-850  (#141418)
surface-overlay:    gray-800  (#1B1B1F)

border-subtle:      gray-800  (11%)
border-default:     gray-700  (17%)
border-strong:      gray-600  (27%)

text-primary:       gray-50   with slight blue tint  (#E8E8F0)
text-secondary:     gray-400  (#8A8A9A)
text-tertiary:      gray-500  (#626270)
text-accent:        accent-400 (#7B6CF0)

accent-default:     accent-500 (#6655EE)
accent-hover:       accent-400 (#7B6CF0)
accent-subtle:      accent-900 at 60% opacity
accent-fg:          white

status-success:     green-400  (#4DC770)
status-warning:     amber-400  (#F5943A)
status-error:       red-400    (#E56B6B)
status-info:        blue-400   (#4D9DE0)

status-subtle-success: green-900  (#1A3D26)
status-subtle-warning: amber-900  (#3D2910)
status-subtle-error:   red-900    (#3D1515)
status-subtle-info:    blue-900   (#0F2640)

interactive-default:  gray-700
interactive-hover:    gray-600
interactive-active:   gray-500
interactive-disabled: gray-800

step-ai-bar:        accent-500  (#6655EE)
step-ai-subtle:     accent-900  at 50% opacity
step-ai-fg:         accent-300  (#9B8EF8)

step-review-bar:    amber-500   (#D97B1A)
step-review-subtle: amber-900   at 50% opacity
step-review-fg:     amber-300   (#FBB962)

step-holding-bar:   gray-600    (#3A3A44)
step-holding-subtle: transparent
step-holding-fg:    gray-400    (#8A8A9A)

step-terminal-bar:  green-500   (#2D9E55)
step-terminal-subtle: green-900 at 50% opacity
step-terminal-fg:   green-300   (#72DCA0)
```

### 3.2 Light Theme

```
surface-base:       gray-100  (#F2F2F5)
surface-default:    gray-50   (#FAFAFE)  (white-ish)
surface-elevated:   white     (#FFFFFF)
surface-overlay:    white     (#FFFFFF)

border-subtle:      gray-200  (88%)
border-default:     gray-200
border-strong:      gray-300

text-primary:       gray-900  (#18181F)
text-secondary:     gray-500  (#636370)
text-tertiary:      gray-400  (#9A9AA6)
text-accent:        accent-600 (#5544CC)

accent-default:     accent-600 (#5544CC)
accent-hover:       accent-500 (#6655EE)
accent-subtle:      accent-200 at 60% opacity
accent-fg:          white

status-success:     green-500  (#2D9E55)
status-warning:     amber-500  (#D97B1A)
status-error:       red-500    (#CC3333)
status-info:        blue-500   (#2476C6)

status-subtle-success: green-900 at low opacity
status-subtle-warning: amber-900 at low opacity
status-subtle-error:   red-900 at low opacity
status-subtle-info:    blue-900 at low opacity

interactive-default:  gray-200
interactive-hover:    gray-300
interactive-active:   gray-400
interactive-disabled: gray-100

step-ai-bar:        accent-600  (#5544CC)
step-ai-subtle:     accent-200  at 40% opacity
step-ai-fg:         accent-700  (#3D2D9E)

step-review-bar:    amber-600   (#B56B10)
step-review-subtle: amber-100   at 60% opacity
step-review-fg:     amber-700   (#8C4B00)

step-holding-bar:   gray-400    (#9A9AA6)
step-holding-subtle: transparent
step-holding-fg:    gray-600    (#636370)

step-terminal-bar:  green-600   (#1E7A40)
step-terminal-subtle: green-100 at 60% opacity
step-terminal-fg:   green-700   (#155730)
```

---

## 4. Component Catalog

Components are organized into three tiers:

- **Atoms** — indivisible primitives
- **Molecules** — composed from atoms, single responsibility
- **Organisms** — complex sections with internal state and layout

---

### Atoms

#### `Text`

**What it is:** The typographic primitive. All visible text in the application flows through this component.

**Variants:** `heading-xl`, `heading-lg`, `heading-md`, `body`, `body-sm`, `label`, `caption`, `mono`, `mono-sm`

**Behavior:**
- Inherits color from context by default; can be overridden with `color` prop (primary, secondary, tertiary, accent, error, etc.)
- No decorative styling; plain rendered text
- `mono` and `mono-sm` use the monospace stack
- Truncation variant: adds `text-overflow: ellipsis` with a `title` tooltip on hover

---

#### `Icon`

**What it is:** An inline SVG icon from the application's icon set.

**Sizes:** `xs` (12px), `sm` (14px), `md` (16px), `lg` (20px), `xl` (24px)

**Behavior:**
- Inherits current text color unless explicitly colored
- `aria-hidden` by default; accepts `aria-label` for standalone decorative icons that convey meaning
- Never interactive on its own; wrap in `Button` for clickable icons

---

#### `Button`

**What it is:** The primary interactive element for user actions.

**Variants:**
- `primary` — filled accent background; used for the main action in a context
- `secondary` — bordered, transparent background; used for supporting actions
- `ghost` — no border, no background; used for inline or low-emphasis actions
- `danger` — filled red background; used exclusively for destructive actions

**Sizes:** `sm`, `md` (default), `lg`

**States:** default, hover, active (pressed), focus-visible, disabled, loading

**Behavior:**
- `loading` state shows a spinner inline and disables interaction
- `danger` variant requires an extra click to confirm (shows inline confirmation text) for actions that are hard to reverse
- Icon-only buttons: render without label but must include `aria-label`
- Full-width variant available for form submit contexts
- Focus ring is always visible when keyboard-focused (not just `:focus`)
- Does not accept mouse down and drag; only click

---

#### `Input`

**What it is:** Text entry control for single-line and multi-line text.

**Variants:** `text` (single line), `textarea` (multi-line)

**States:** default, focused, filled, invalid, disabled, read-only

**Behavior:**
- `textarea` auto-grows vertically with content up to a `max-rows` limit, then scrolls
- Invalid state shows `border-strong` in red and an error message below via `FormField`
- Placeholder text uses `text-tertiary` color
- Clear button appears on right side when `clearable` prop is set and input has content
- Code variant uses monospace font stack
- Focus ring uses `border-strong` in accent color

---

#### `Select`

**What it is:** Single-option dropdown selector.

**States:** default, open, focused, disabled

**Behavior:**
- Opens downward by default; flips upward if insufficient space below
- Options list scrolls when more than 8 options are present
- Supports grouped options with a section header label
- Keyboard: `↑`/`↓` to navigate, `Enter` to select, `Escape` to close
- Selected option is visually marked with a checkmark icon
- No multi-select variant — use `Chip` input pattern for that

---

#### `Toggle`

**What it is:** A binary on/off control. Used for settings and boolean configuration fields.

**Variants:** `switch` (sliding pill), `checkbox` (box with checkmark)

**States:** off, on, indeterminate (checkbox only), disabled

**Behavior:**
- `switch` toggles instantly on click/tap; no separate confirm step
- `checkbox` supports indeterminate state for "select all" patterns
- Always has an associated label (visible or aria-label)
- Keyboard: `Space` to toggle

---

#### `Chip`

**What it is:** A compact, optionally dismissible label. Used for tags, active filters, and multi-select values.

**Variants:** `static` (display only), `filter` (toggleable), `input` (dismissible, used in tag inputs)

**States:** default, active (toggled on), hover, disabled

**Behavior:**
- `filter` chips toggle their active state on click; active chips show a filled background in `accent-subtle`
- `input` chips show an `×` dismiss button on hover or focus
- Maximum content is one line; overflows with ellipsis
- Chips in a group wrap onto multiple lines if needed

---

#### `Badge`

**What it is:** A compact semantic label conveying status, count, or category.

**Variants (by intent):** `success`, `warning`, `error`, `info`, `neutral`, `accent`

**Sizes:** `sm` (default), `md`

**Behavior:**
- Non-interactive; purely informational
- Shows a colored dot + label text, or just a dot (icon-only mode)
- `neutral` variant: gray background, used for workflow step names or categories
- Numeric count variant: shows a number (e.g., "3"), used on nav items for alert counts
- Never wraps — truncates at a maximum width

---

#### `Spinner`

**What it is:** A loading/indeterminate progress indicator.

**Variants:** `circular` (spinning ring), `linear` (bar across a container width)

**Sizes:** `xs`, `sm` (default), `md`, `lg`

**Behavior:**
- `circular` rotates continuously; uses CSS animation for GPU acceleration
- `linear` pulses left-to-right for indeterminate progress; can also accept a 0–100 value for determinate progress
- Always accompanied by a screen-reader-accessible label (visible or aria-label)
- Inherits current text color by default

---

#### `Divider`

**What it is:** A visual separator between content sections.

**Variants:** `horizontal` (default), `vertical`

**Behavior:**
- Renders as a 1px line in `border-subtle` color
- Optional label text centered on the line, in `text-tertiary` style
- Vertical variant used inside flex rows to separate toolbar items

---

#### `Tooltip`

**What it is:** A floating label that appears on hover/focus of an element, providing a brief description.

**Behavior:**
- Appears after a 400ms delay on hover; immediately on keyboard focus
- Disappears instantly on mouse-out
- Positioned automatically (top by default; flips to avoid viewport edge)
- Single line of text only; max 200 characters
- Never contains interactive elements
- `aria-describedby` is wired automatically

---

#### `Skeleton`

**What it is:** A loading placeholder that approximates the shape of the content that will appear.

**Variants:** `text` (line), `block` (rectangle), `circle`

**Behavior:**
- Pulses between two close neutral shades using a shimmer animation
- Composed into larger skeleton layouts (e.g., a `Skeleton.Card` shows a skeleton card shape)
- Replaced with real content when data arrives; no fade transition (instant swap)

---

#### `RelativeTime`

**What it is:** A timestamp displayed as a human-readable relative duration (e.g., "3 hours ago").

**Behavior:**
- Updates live every 30 seconds for recent timestamps (< 24h old)
- Displays full absolute datetime in a tooltip on hover
- Stops updating and shows a formatted date for timestamps older than 7 days
- Always accessible: renders `<time>` element with `datetime` attribute

---

### Molecules

#### `FormField`

**What it is:** A labeled wrapper for a single form control. Provides consistent layout for label, input, hint, and error message.

**Behavior:**
- Label sits above the control by default; can be positioned inline (to the left) for settings forms
- Error message replaces hint text when validation fails; shows in error color
- Required indicator (`*`) appears on the label when the field is required
- Wraps any atom: `Input`, `Select`, `Toggle`, `Chip` input
- Handles `id`/`aria-labelledby` wiring automatically

---

#### `SearchInput`

**What it is:** A specialized input for filtering/searching a list in the current view.

**Behavior:**
- Search icon on the left side of the input (non-interactive)
- Clear button (`×`) appears on the right when the field has a value
- Triggers filtering on every keystroke with a short debounce (150ms)
- Pressing `Escape` clears the field and returns focus to the trigger (if invoked via keyboard)
- Empty state: shows placeholder text like "Search tasks..."
- No submit button; purely reactive

---

#### `Card`

**What it is:** A contained surface for grouping related content.

**Variants:** `default` (with border), `flat` (no border, background only), `interactive` (hoverable, clickable)

**Behavior:**
- `interactive` variant shows hover background shift and cursor pointer; entire card is the click target
- Optionally has a `header` slot (title + optional action icon) separated by `border-subtle`
- Optionally has a `footer` slot separated by `border-subtle`
- No shadow in dark theme; slight shadow in light theme (elevation-1)
- Does not implement scrolling; if content overflows, the parent is responsible

---

#### `Modal`

**What it is:** A blocking overlay dialog for focused tasks, confirmations, and forms.

**Variants:** `dialog` (small, centered), `sheet` (larger, centered), `confirm` (minimal, two-button only)

**Behavior:**
- Backdrop dims the page (scrim at 50% opacity)
- Entry: slides up 8px and fades in over 200ms
- Exit: fades out over 120ms
- Focus is trapped inside while open; returns to trigger element on close
- Pressing `Escape` closes the modal
- `confirm` variant: shows a title, brief description, and two buttons (primary action + cancel); no close icon
- `dialog` and `sheet` variants: include a close icon in the top-right corner
- Scrollable body when content overflows
- Never stacks more than two modals deep

---

#### `Panel`

**What it is:** A persistent side panel that slides in from the right edge of the viewport, sitting alongside the main content.

**Behavior:**
- Opens by sliding in from the right (200ms ease-out)
- Width: 360px by default; resizable by dragging the left edge (min 280px, max 560px)
- Close button in the top-right; `Escape` also closes when the panel has focus
- Header: entity name (editable inline) + type badge + close button
- Body: scrollable
- Panel state persists across navigation (stays open when switching between pages)
- Detach button: opens the panel content in a floating pop-out window; panel closes in the main view
- Multiple panels do not stack; opening a new panel replaces the previous one

---

#### `Toast`

**What it is:** An ephemeral notification that appears at the bottom-right of the screen.

**Variants:** `success`, `error`, `warning`, `info`

**Behavior:**
- Appears by sliding up 8px and fading in
- Auto-dismisses after 4 seconds for success/info; stays until dismissed for error
- Multiple toasts stack vertically; maximum 3 visible at once (older ones fade out)
- Manual dismiss via `×` button
- Hover pauses the auto-dismiss timer
- Never blocks interaction with the page behind it

---

#### `EmptyState`

**What it is:** A placeholder shown when a list or section has no content.

**Behavior:**
- Shows a subtle icon, a brief title, and optionally one sentence of explanation
- Optionally includes a single primary action button (e.g., "Add project")
- Centered in its container
- Icon is decorative only; no animation
- Distinguishes between "no results" (filtered empty) and "nothing exists yet" (genuinely empty) via different copy

---

#### `StatusBadge`

**What it is:** A composite label that communicates a task's current execution state. More specific than a generic `Badge` — this is the canonical representation of "what is a task doing right now."

**States:**
- `queued` — neutral, "Queued"
- `executing` — info + spinner, "Running"
- `waiting` — warning, "Waiting"
- `completed` — success, "Done"
- `failed` — error, "Failed"
- `pending_review` — warning, "Needs Review"
- `workflow:step` — neutral, showing the workflow name + step name as `workflow / step`

**Behavior:**
- `executing` state shows an inline spinner to the left of the label
- Clicking does nothing (non-interactive by default)
- Optional `onClick` makes it interactive (e.g., navigate to traces)
- Size follows the parent context

---

#### `IdentityBadge`

**What it is:** A compact display of a short UUID prefix used to identify tasks, steps, and workflows in the UI.

**Behavior:**
- Shows first 8 characters of the UUID in monospace font
- Muted appearance (`text-tertiary`, small)
- Clicking copies the full UUID to clipboard; shows brief "Copied" confirmation
- Tooltip shows the full UUID on hover

---

#### `ChatMessage`

**What it is:** A single turn in an AI conversation — either a user message or an assistant response.

**Variants:** `user`, `assistant`

**Behavior:**
- `user` messages: right-aligned, accent-tinted background
- `assistant` messages: left-aligned, surface background
- Supports streaming: text appends character-by-character in real time
- Markdown rendering: bold, italic, code blocks, bullet lists
- Code blocks: syntax-highlighted, with a copy button
- Timestamp shown on hover
- `assistant` messages may contain one or more `ToolCallBlock` children
- No avatar — role is indicated by alignment and background only

---

#### `ToolCallBlock`

**What it is:** An expandable block inside an assistant message that shows a tool call and its result.

**Behavior:**
- Collapsed by default: shows the tool name and a summary line (e.g., "Read file src/main.rs")
- Expand/collapse with a chevron toggle
- Expanded: shows the full input parameters and output result in a monospace block
- States: `pending` (spinner), `success` (green border-left), `error` (red border-left)
- Long outputs scroll within a fixed height container (max ~200px)

---

#### `TreeNode`

**What it is:** A single row in a hierarchical tree list. Represents a task at any level of the hierarchy.

**Behavior:**
- Indent level is conveyed by left padding (16px per level)
- Expand/collapse chevron on the left when node has children; no chevron when leaf
- Clicking the row body selects the item and opens its detail panel
- Clicking the chevron toggles expanded state without selecting
- Right-aligned: status badge, run status indicator (if executing)
- Selected state: `accent-subtle` background, `accent` left border (2px)
- Hover state: `interactive-hover` background
- Keyboard: `→` expands, `←` collapses, `Enter` selects, `Space` toggles expand/collapse

---

#### `FilterBar`

**What it is:** A horizontal row of filter controls for narrowing a list view.

**Behavior:**
- Contains a `SearchInput` on the left
- Followed by a set of `Select` or `Chip` group filters (e.g., Level, Step, Tags)
- "Clear filters" action appears at the right end when any filter is active
- Filters are applied immediately (no submit button)
- Filter state persists in the URL query string for shareability
- Chips show the active filter value inline (e.g., "Level: Ticket")
- Collapses gracefully at narrow widths; overflow filters go into a "More filters" popover

---

### Organisms

#### `Sidebar`

**What it is:** The fixed left navigation rail — always visible, always accessible.

**Structure:**
- Top: application logo mark
- Below logo: project switcher button (shows project initials or icon)
- Nav section 1 (Operations): Operations, Board, Design
- Divider
- Nav section 2 (Content): Tasks, Traces
- Spacer (flex-grow)
- Bottom: Project Chat button, Theme Toggle

**Behavior:**
- Width: 48px always (icon-only; no text labels)
- Active page indicator: accent-colored left border (2px) + `accent-subtle` background on the icon
- Icon tooltip shows page name on hover (300ms delay)
- Project switcher opens the Project Setup page or a project-selection popover
- Chat button opens the floating ChatPanel
- Theme toggle switches between dark/light themes; persists to local storage
- No collapse/expand behavior — always at 48px

---

#### `Header`

**What it is:** The page-level header bar, sitting above the main content area.

**Structure:**
- Left: Page title (`text-xl`) + optional subtitle (`text-sm`, `text-secondary`)
- Center: Optional status info (e.g., "3 live tasks")
- Right: Page-specific action buttons (optional)

**Behavior:**
- Height: 48px
- Does not scroll with content (sticky)
- Page-specific content (filter bars) appears immediately below the header, as part of the page, not the header itself
- Live counts (operations count, active task count) update in real time via subscriptions

---

#### `AppShell`

**What it is:** The root layout of the application. Provides the skeleton that all pages render within.

**Structure:**
```
┌─────────────────────────────────────────┐
│  Sidebar (48px fixed)  │   Header (48px) │
│                        ├─────────────────┤
│                        │  Page Content   │
│                        │  (scrollable)   │
└────────────────────────┴─────────────────┘
```

**Behavior:**
- Sidebar is always present
- Header is always present
- Main content area scrolls independently
- A detail `Panel` slides in from the right, overlapping the main content (not pushing it)
- Connection status indicator floats at bottom-right when disconnected
- Toast notifications appear at bottom-right, above the connection status
- Global keyboard shortcuts are registered at this level

---

#### `ChatPanel`

**What it is:** The unified chat interface for interacting with the AI agent. Handles project-level, task-scoped, and step-scoped conversations.

**Structure:**
- Header: Scope indicator (e.g., "Project Chat", "Task: #abc123ef"), close button, detach button
- Tab bar: Shows open chat sessions when multiple are active; each tab labeled with scope
- Body: Scrollable message history (`ChatMessage` items, bottom-aligned)
- Footer: Input area — `Input` with `Send` button, optional attachment control, streaming stop button
- Optional context indicator: "Scoped to task #abc123ef" banner when task-scoped

**Behavior:**
- Opens as a floating panel anchored to the bottom-right, above the sidebar
- Width: 420px; resizable
- New messages scroll into view automatically; pauses auto-scroll if the user manually scrolls up
- Streaming messages show a blinking cursor at the end
- "Stop generating" button replaces "Send" during streaming
- Token/context meter: a thin progress bar at the top of the input area showing context window usage (colored: green → amber → red as usage increases)
- Detach: opens in a separate window; session continues without interruption
- Sessions are per-scope; switching tabs preserves history and scroll position

---

#### `DetailPanel`

**What it is:** The universal side panel for viewing and editing the details of a selected entity (task, step, or workflow).

**Structure (task entity):**
- Header: Editable title field + `IdentityBadge` + `StatusBadge` + close + detach buttons
- Section: Metadata (created, updated, priority) — collapsed by default
- Section: Description — inline editable `textarea`
- Section: Acceptance Criteria — checklist items, collapsible
- Section: Spec — free text, collapsible
- Section: Code References — list of linked source locations, collapsible
- Section: Dependencies — parent, blockers, collapsible
- Section: Relations — children, dependents, collapsible
- Section: Custom Sections — any additional sections added to the task
- Footer: Action bar with "Open Chat", "Run", "Delete" actions

**Structure (step entity):**
- Header: Step name + type indicator + close button
- Section: Instructions — editable text with liquid variable highlighting
- Section: Agent Config — model selector, system prompt textarea, tool toggles

**Structure (workflow entity):**
- Header: Workflow name + close button
- Section: Kanban column assignment
- Section: Steps list (linked)

**Behavior:**
- Sections are individually collapsible; state persists to local storage
- Inline editing: clicking a field activates an editable control in-place; saves on blur or `Cmd+S`; cancels on `Escape`
- Unsaved changes show a dot indicator on the header close button; closing with unsaved changes prompts a confirmation
- Human review gate: when a task is in `pending_review`, an approval/reject action bar appears at the top of the panel, above all sections
- Resizable from the left edge (320px min, 560px max)

---

#### `KanbanColumn`

**What it is:** A vertical column in the board view, representing one workflow step's task pool. Shares the same step-type color vocabulary as `WorkflowNode`.

**Structure:**
- Column header: 2px left border in `step-{type}-bar` color + Step name + task count badge
- Body: Vertically scrollable list of task cards
- Each task card: title, `IdentityBadge`, `StatusBadge`, optional run status

**Step type left border mapping:**
- AI step → indigo (`step-ai-bar`)
- Review step → amber (`step-review-bar`)
- Holding step → gray (`step-holding-bar`)
- Terminal step → green (`step-terminal-bar`)

**Behavior:**
- Columns are horizontally scrollable as a group when there are many
- Clicking a task card selects it and opens the `DetailPanel`
- Cards do not support drag-and-drop reordering (tasks move via workflow transitions, not drag)
- Column width: 240px fixed
- Long task titles truncate with ellipsis; full title in tooltip

---

#### `WorkflowNode`

**What it is:** A node in the workflow DAG diagram. Represents one step in a workflow, with its type visually encoded through a top accent bar and background tint.

**Step types:**

| Type | Bar color | Icon | Background tint | Meaning |
|------|-----------|------|----------------|---------|
| AI | `step-ai-bar` (indigo) | ⚡ | `step-ai-subtle` | Agent executes here |
| Review | `step-review-bar` (amber) | 👁 | `step-review-subtle` | Human must act |
| Holding | `step-holding-bar` (gray) | ⏸ | None | Passive queue |
| Terminal | `step-terminal-bar` (green) | ✓ | `step-terminal-subtle` | End state |

**Structure:**
- Top accent bar: 3px horizontal strip across the full node width (`step-{type}-bar` color)
- Row 1: Step name (left) + type icon 14px (right, `step-{type}-fg` color)
- Row 2: Task count (left) + run state summary (right)
- Background: `surface-elevated` + `step-{type}-subtle` tint overlay
- Incoming + outgoing edge connectors

**Node dimensions:** 180px × 72px.

**States:**
- Default: `surface-elevated` + type tint + type bar at top
- Hover: bg one level lighter, `elevation-1` shadow
- Selected: `accent-default` 2px full border, `elevation-2` shadow + `NodeActionPopover` appears below
- Executing: type bar pulses (100% → 50% → 100% opacity, 1.5s loop)
- Failed: `status-error` 2px left border (stacks with type bar)

**Canvas overlay elements triggered by this node:**
- Hover (400ms): `NodeHoverTooltip` appears beside cursor (step name, type, task counts, recency)
- Selected (150ms delay): `NodeActionPopover` floats 8px below node
- When executing: contributes to the `LiveExecutionBanner`

**Behavior:**
- Clicking selects the node and opens the `StepDetailPanel` (docked right panel)
- Nodes are positioned automatically by ELK layout; cannot be manually dragged
- Edges are orthogonally routed; labeled with transition condition on hover
- Zoom and pan via scroll + drag on canvas background

---

#### `SectionGroup`

**What it is:** A collapsible labeled section used within `DetailPanel` and other detail views.

**Structure:**
- Header row: label text + chevron icon + optional count badge
- Body: slot for any content

**Behavior:**
- Click anywhere on the header row to toggle expand/collapse
- Chevron rotates 90° when expanded (200ms transition)
- Collapsed state shows count badge (number of items) if provided
- Body has a max-height collapse animation (200ms)
- Header stays sticky within a scrollable panel when the body is tall

---

### Page Templates

#### `ListPage`

**What it is:** The template for pages that primarily display a hierarchical or flat list of tasks (Tasks page).

**Structure:**
```
Header (page title + item count)
FilterBar (search + level + step + tags filters)
────────────────────────────────
TreeView (scrollable, fills remaining height)
```

**Behavior:**
- Selecting an item opens the `DetailPanel` alongside
- Expand/Collapse All button in the header right area
- Footer shows total item count + filtered count when filters are active
- Empty state when no items match filters

---

#### `BoardPage`

**What it is:** The kanban board template (Board page).

**Structure:**
```
Header (page title + level filter + search)
────────────────────────────────
Horizontal scrolling columns of KanbanColumns
```

**Behavior:**
- Columns are ordered by workflow topology (topological sort of workflow transitions)
- Selecting a card opens the `DetailPanel` on the right, narrowing the column area
- Columns can be horizontally scrolled even when the panel is open
- No task creation directly from the board; tasks are created via the CLI or task panel

---

#### `DAGPage`

**What it is:** The workflow pipeline diagram template (Design page).

**Structure:**
```
Header (page title)
────────────────────────────────
Full-canvas ReactFlow diagram (fills remaining height)
  [Toolbar: fit-to-view, zoom controls]
  [WorkflowNodes, edges]
```

**Behavior:**
- Clicking a node opens `StepDetailPanel` in overlay on the right
- Clicking a workflow zone opens `WorkflowDetailPanel`
- Canvas toolbar is pinned to top-right of the canvas area
- Node selection is highlighted with an accent border ring
- Background: dot grid pattern in `border-subtle` color

---

#### `DashboardPage`

**What it is:** The operations/overview template (Operations page).

**Structure:**
```
Header (page title + live count badge)
────────────────────────────────
Section: Needs Attention (failed runs + review requests)
Section: Live (actively executing tasks)
Section: Recently Completed
Section: Ready to Run
```

**Behavior:**
- Sections are always visible (not collapsible at this level)
- Each section auto-hides when it has zero items (seamless collapse)
- Each item row is clickable → opens `DetailPanel`
- Entire page updates in real time via subscriptions; new items animate in (slide + fade, 200ms)
- Item count in the header reflects only "live" items, not total page items

---

#### `SetupPage`

**What it is:** The initial project configuration screen shown when no project is loaded, or when the user navigates to project settings.

**Structure:**
```
Centered layout (no sidebar chrome when no project loaded)
────────────────────────────────
Title: "Select a project"
Project list (each project: name, path, select button)
"Add project" button → native file picker
```

**Behavior:**
- Selecting a project loads it and navigates to the Operations page
- "Remove" action available per project (with confirmation)
- When accessed from sidebar (project is already loaded), the sidebar remains visible

---

#### `TracesPage`

**What it is:** The agent execution inspector (Traces page). A specialized page for reviewing what an agent did during a task run.

**Structure:**
```
Header (page title + view mode toggle)
────────────────────────────────
Left rail (200px): Task picker — filterable list of tasks
Left rail (200px): Run history for selected task
Main area: Execution view (fills remaining space)
```

**Behavior — Execution View modes:**
- `Thread` mode: displays the execution as a unified chat timeline (`ChatMessage` + `ToolCallBlock` items)
- `Timeline` mode: displays events as a horizontal timeline, grouped by sub-agent and turn
- Mode is toggled via a segmented control in the header
- Both modes support filtering by event type (tool calls, errors, thoughts)
- Human input gate: if a run is in `pending_review`, a banner appears at the top of the main area with approve/reject actions
- Stop button: appears when a run is actively executing; visible in the header
- Subtree rail: when a task has child task executions, a collapsible right rail shows them; clicking one updates the main area to show that sub-execution's trace

---

#### `NodeActionPopover`

**What it is:** A compact floating action panel that appears anchored below (or above) a selected `WorkflowNode` on the canvas. Provides quick actions without requiring the user to look at the docked detail panel.

**Structure:**
- Left: primary action button (`ghost` compact variant) — e.g., "▶ Run next task" or "■ Stop run"
- Vertical separator (`border-subtle`, 1px)
- Right: compact run summary — ✓ count · ✗ count · ⟳ count

**Behavior:**
- Appears 150ms after node is selected (delay prevents flash when clicking through nodes)
- Positioned 8px below the node's bottom edge; flips above if < 80px below viewport bottom
- Centered horizontally relative to the node
- Disappears when: node deselected, canvas pan starts, `Escape` pressed
- Updates live (run count, active state) without closing
- Coexists with the docked `DetailPanel` — both can be visible simultaneously

---

#### `LiveExecutionBanner`

**What it is:** A floating pill that appears at the top of the pipeline canvas when any tasks are actively running. Provides ambient awareness of system activity without requiring navigation.

**Structure:**
- ⟳ spinning icon + "N running" count
- `·` separator
- Per-step chips showing step name + count (e.g., "In Progress (2)")

**Behavior:**
- Appears (slides down 8px + fade in, 200ms) when first execution starts
- Step chips are clickable — clicking one flies-to and flashes the relevant nodes on the canvas
- Disappears (fades out, 150ms) 2 seconds after the last active run completes
- Never shown when no runs are active

---

#### `CanvasMiniMap`

**What it is:** A small overview map in the bottom-right corner of the pipeline canvas, for navigating large pipelines (> 8 nodes).

**Structure:**
- Viewport rectangle (accent-tinted, 1px accent border) showing current view position
- Node dots: one dot per node, colored by `step-{type}-bar`
- Edge lines: 1px `border-subtle` connecting dots

**Behavior:**
- Only appears when node count > 8 (small pipelines fit in view naturally)
- Drag the viewport rectangle to pan the main canvas
- Click a node dot to center and zoom to that node
- Semi-transparent background (80% opacity) — does not fully obscure the canvas corner

---

#### `PopoutWindow`

**What it is:** A detached window layout for task details, chat sessions, or traces, opened from within the main app.

**Structure:**
```
Slim title bar (entity name + close button)
────────────────────────────────
Content (same as the panel component, but full window)
```

**Behavior:**
- Inherits the same theme as the main window
- Always on top optional
- Resizable and draggable
- Closing the window does not close the entity; can be re-opened from main app
- Real-time updates continue regardless of whether the main window is in focus

---

## 5. Interaction Patterns

### 5.1 Selection and Detail

The application uses a **primary/secondary** split: the main area shows the list or diagram; the right panel shows the selected item's detail. This avoids full-page navigation for most actions.

- Clicking any item in a list, board, or diagram opens its `DetailPanel`
- Only one item can be selected at a time
- Pressing `Escape` deselects and closes the panel
- The panel persists when navigating between pages (continuity)
- For deep focus, the panel can be detached into a `PopoutWindow`

### 5.2 Inline Editing

Fields in `DetailPanel` are inline-editable — no separate "edit mode."

- Clicking a text field activates it for editing
- `Cmd+S` or `Ctrl+S` saves
- `Escape` cancels and reverts
- Unsaved state is indicated by a subtle dot on the save indicator
- Auto-save on blur after a 500ms debounce

### 5.3 Real-time Updates

Data arrives via subscriptions and updates the UI in place.

- **Lists**: new items slide in; removed items fade and collapse
- **Status changes**: badges update in place with a brief background flash (200ms)
- **Streaming text**: characters appear one by one in chat messages
- **Counts**: numbers in badges and headers increment/decrement with a quick fade
- No "refresh" button — the UI is always current

### 5.4 Human-in-the-Loop

When an agent requests human approval (human input gate), the application surfaces this prominently.

- A persistent banner appears at the top of the relevant `DetailPanel`
- The `Needs Attention` section on the Operations page also surfaces it
- Approve and Reject buttons are large and clearly labeled
- Rejecting shows an optional text input for feedback

### 5.5 Keyboard Navigation

Every page supports keyboard-first navigation:

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate list items |
| `→` / `←` | Expand / collapse tree node |
| `Enter` | Select item / confirm |
| `Escape` | Close panel / cancel edit / deselect |
| `Cmd/Ctrl+S` | Save current edit |
| `Cmd/Ctrl+K` | Open task search / command palette (future) |
| `Space` | Toggle tree node expansion |

Focus is always visible (never hidden for keyboard users).

### 5.6 Destructive Actions

Two-step confirmation for any hard-to-reverse action:

- `Button` with `danger` variant shows a confirmation prompt inline
- Or a `Modal` with `confirm` variant for more impactful actions
- Cancel is always the default action (first in tab order)
- Copy of the item name shown in the confirmation to prevent accidental deletion

---

## 6. Pages

| Page | Route | Purpose | Real-time | Key Components |
|------|-------|---------|-----------|----------------|
| **Operations** | `/operations` | Live system dashboard | Yes — fully live | `DashboardPage`, `StatusBadge`, `RelativeTime` |
| **Board** | `/board` | Kanban task management | Yes — status updates | `BoardPage`, `KanbanColumn`, task cards |
| **Design** | `/design` | Workflow DAG editor | Yes — execution state | `DAGPage`, `WorkflowNode` |
| **Tasks** | `/tasks` | Hierarchical task tree | Yes — status updates | `ListPage`, `FilterBar`, `TreeNode` |
| **Traces** | `/traces/:taskId?` | Agent execution inspector | Yes — active runs | `TracesPage`, `ChatMessage`, `ToolCallBlock` |
| **Setup** | `/setup` | Project selection | No | `SetupPage` |
| **Styleguide** | `/styleguide` | Design system reference | No | All components |
| **Popout: Task** | `/task/:id` | Detached task detail | Yes | `PopoutWindow`, `DetailPanel` |
| **Popout: Chat** | `/chat` | Detached chat session | Yes — streaming | `PopoutWindow`, `ChatPanel` |
| **Popout: Traces** | `/traces-window/:id` | Detached trace inspector | Yes — active runs | `PopoutWindow`, `TracesPage` |

---

## 7. Component Summary Table

| Component | Tier | Description |
|-----------|------|-------------|
| `Text` | Atom | Typography primitive |
| `Icon` | Atom | SVG icon wrapper |
| `Button` | Atom | Interactive action control |
| `Input` | Atom | Text entry (single + multi-line) |
| `Select` | Atom | Dropdown single-select |
| `Toggle` | Atom | Binary on/off (switch or checkbox) |
| `Chip` | Atom | Tag / filter label |
| `Badge` | Atom | Semantic status label |
| `Spinner` | Atom | Loading indicator |
| `Divider` | Atom | Visual separator |
| `Tooltip` | Atom | Hover/focus label |
| `Skeleton` | Atom | Loading placeholder |
| `RelativeTime` | Atom | Live-updating relative timestamp |
| `FormField` | Molecule | Label + input + error wrapper |
| `SearchInput` | Molecule | Reactive search control |
| `Card` | Molecule | Content surface container |
| `Modal` | Molecule | Blocking overlay dialog |
| `Panel` | Molecule | Resizable side panel |
| `Toast` | Molecule | Ephemeral notification |
| `EmptyState` | Molecule | Zero-data placeholder |
| `StatusBadge` | Molecule | Task execution state display |
| `IdentityBadge` | Molecule | Copyable UUID prefix display |
| `ChatMessage` | Molecule | Conversation message (user or AI) |
| `ToolCallBlock` | Molecule | Expandable tool call + result |
| `TreeNode` | Molecule | Hierarchical list row |
| `FilterBar` | Molecule | Multi-filter control row |
| `Sidebar` | Organism | App navigation rail |
| `Header` | Organism | Page header bar |
| `AppShell` | Organism | Root layout skeleton |
| `ChatPanel` | Organism | Full chat interface |
| `DetailPanel` | Organism | Entity detail side panel |
| `KanbanColumn` | Organism | Board column with task cards |
| `WorkflowNode` | Organism | DAG step node with type-color encoding |
| `SectionGroup` | Organism | Collapsible labeled section |
| `NodeActionPopover` | Organism | Canvas-floating quick actions for selected node |
| `LiveExecutionBanner` | Organism | Canvas-floating active run status pill |
| `CanvasMiniMap` | Organism | Canvas overview navigation (> 8 nodes) |
| `ListPage` | Template | Filterable task list page |
| `BoardPage` | Template | Kanban board page |
| `DAGPage` | Template | Full-canvas diagram page |
| `DashboardPage` | Template | Multi-section overview page |
| `SetupPage` | Template | Project onboarding page |
| `TracesPage` | Template | Execution inspector page |
| `PopoutWindow` | Template | Detached floating window |

**Total: 44 components** (13 atoms, 13 molecules, 11 organisms, 7 page templates)

*v1.1 additions: `NodeActionPopover`, `LiveExecutionBanner`, `CanvasMiniMap` — canvas overlay organisms for the pipeline view. Step-type semantic tokens added to both themes.*

---

*End of Vertebrae Design System v1.0*
