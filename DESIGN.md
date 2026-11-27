---
version: beta
name: Hearth (Vertebrae GUI)
description: Vertebrae's desktop GUI design system. Charcoal surfaces with a rose-quartz accent (mulberry on cream in light), Geist for interface text, JetBrains Mono for data, and Newsreader reserved for brand and display moments. Glow is reserved as a semantic signal for live execution state.
colors:
  bg: "#0a0a0a"
  bg-1: "#111111"
  bg-2: "#161616"
  bg-3: "#1f1f1f"
  bg-4: "#2a2a2a"
  fg: "#f4f1ec"
  fg-soft: "#b8b5af"
  fg-mute: "#6f6c66"
  fg-faint: "#4a4742"
  line: "#1f1f1f"
  line-strong: "#2a2a2a"
  accent: "#dda7c7"
  accent-deep: "#eac1d9"
  accent-wash: "#2d2029"
  on-primary: "#0a0a0a"
  bg-light: "#faf6ec"
  bg-1-light: "#f2ede0"
  fg-light: "#1a1a20"
  fg-mute-light: "#66665e"
  line-light: "#dcd4c1"
  accent-light: "#854568"
typography:
  family-sans: "Geist"
  family-mono: "JetBrains Mono"
  family-serif: "Newsreader"
  size-content: "14px"
  size-secondary: "13px"
  size-meta: "12px"
rounded:
  xs: "2px"
  sm: "3px"
  md: "5px"
  lg: "8px"
  xl: "12px"
  full: "9999px"
---

# Hearth, the Vertebrae GUI design system

Tokens live in `crates/gui/src/index.css` (`@theme` primitives plus the `:root`
adapter vocabulary `--bg`, `--fg`, `--s-*`, `--r-*`). This document describes
the rules for using them; when a value here and `index.css` disagree,
`index.css` wins and this file should be corrected.

Hearth is a quiet chrome: tonal surface steps, hairlines, one accent, and
generous spacing. Static UI is flat. The rule that keeps execution state
legible:

> **Glow means running. Nothing else.**

Hover, selection, focus, and emphasis are conveyed through tonal shifts and
the accent. A glow appears only on entities that are actively executing — an
in-progress step pill, a live timeline node, a streaming speaker ember, an
animated edge for a transition currently flowing.

## Colors

### Dark theme (default)

| Token | Value | Role |
| --- | --- | --- |
| `--color-bg` | `#0a0a0a` | App background |
| `--color-bg-1` | `#111111` | Panels, panes |
| `--color-bg-2` | `#161616` | Raised surfaces, popovers, composer |
| `--color-bg-3` / `bg-4` | `#1f1f1f` / `#2a2a2a` | Hover, selected rows, chips |
| `--color-line` / `line-strong` | `#1f1f1f` / `#2a2a2a` | Hairlines, emphasized dividers |
| `--color-fg` | `#f4f1ec` | Body, headings |
| `--color-fg-soft` | `#b8b5af` | Secondary copy, controls at rest |
| `--color-fg-mute` | `#6f6c66` | Labels, timestamps, icons at rest |
| `--color-fg-faint` | `#4a4742` | Decorative marks, completed-activity dots |
| `--color-accent` | `#dda7c7` | Primary action, selection indicator, focus |
| `--color-accent-wash` | `#2d2029` | Selected nav item, accent badges |

### Light theme

`.light` on `<html>` swaps to warm cream paper (`--color-bg #faf6ec`,
`--color-fg #1a1a20`, `--color-line #dcd4c1`) and a mulberry accent
(`#854568`). Status colors are re-tuned per theme for contrast.

### Status and step kinds

`--color-ok`, `--color-warn`, `--color-err`, `--color-info` (each with a
`-wash` variant) are semantic only. Step types keep their own hues
(`--color-step-*`, with `-wash` and `-fg` variants); this is the sanctioned
exception to the one-accent rule, used as icon/lamp tints, never as fills for
whole surfaces.

Theme is toggled by adding `light` or `dark` to `<html>` (see
`hooks/useTheme.ts`). The default is dark.

## Typography

| Role | Family | Use |
| --- | --- | --- |
| Interface | Geist 400/500/600 | All chrome: pane and panel titles, buttons, menus, labels, body copy |
| Data | JetBrains Mono 400/500 | IDs, timestamps, token/context counts, model IDs, paths, code, step-type values |
| Display | Newsreader | Brand wordmark and project monogram, empty-state marks, Hearth "cursive roles" (accent numerals, ledes, field hints, inline `<em>`) |


### Type scale

One scale on a 14px content base. Every font size uses one of its tokens, defined
in `crates/gui/src/styles/tokens.css`; text of equal importance uses the same
token on every surface.

| Token | Default | Use |
| --- | --- | --- |
| `--text-content` (`text-content`) | 14px | Chat prose, user turns, the composer, file names, table cells, task titles, body copy |
| `--text-code` (`text-code`) | = secondary | Code blocks, Pierre diffs (`--diffs-font-size`), `CodeSnippet`, `PierrePanelCode`, call trees |
| `--text-secondary` (`text-secondary`) | 13px | Supporting text, controls, labels, descriptions, inline code within content |
| `--text-meta` (`text-meta`) | 12px | Timestamps, counts, IDs, badges, key hints, eyebrows; the smallest text size |
| `--text-lg` … `--text-5xl`, `--text-lede`, `--text-hero`, `--text-display` | 16–56px, clamp | Headings, ledes and display moments |

- **One scaling mechanism.** Settings → Appearance → Text size (75–150%) sets
  `--text-scale`, and the root font size is `16px × --text-scale`. All tokens
  are rem, so every surface scales together. There is no density mode, no
  per-surface reading scale and no screen- or width-dependent root size.
- **No literal font sizes.** Stylelint's `vertebrae/no-font-size-literals`
  rejects px/rem font sizes (including the `font` shorthand and
  `--*font-size` properties) outside `tokens.css`;
  `scripts/check-font-size-classes.mjs` rejects `text-[Npx]` classes, retired
  Tailwind sizes (`text-xs`, `text-sm`, `text-base`, …) and literal inline
  `fontSize` values. Both run in `npm run lint:css`. Relative sizes (`em`, `%`)
  are allowed for fixed relationships to the surrounding text.
- **Exception: SVG user units.** SVG text laid out in diagram user units keeps
  numeric sizes because the diagram's zoom scales it: the statechart viewer
  (`Artifacts/StatechartViewer.tsx`) and machine-diagram parts
  (`MachineDiagram/SvgText.tsx`, `MIN_TEXT_SIZE`).
- **Mono is for data, not labels.** Speaker labels, section headings and menu
  items are sans; do not set them in caps-mono.
- **Serif is never chrome.** Pane titles, panel/modal titles and breadcrumbs
  are sans.

## Hierarchy and elevation

Hierarchy is composed from:

1. **1px borders** in `border` or `border-strong`.
2. **Tonal background shifts** — `bg-primary` → `bg-secondary` → `bg-tertiary` (~6 lightness steps each).
3. **The SpineRule divider** between major sections (see Components).

**No box-shadow for in-flow elevation.** Cards, buttons, inputs and rows do not use shadow to suggest depth. The only allowed shadows are:

- The semantic glow utilities scoped to running-state (see below).
- The shared focus halo (see Focus below).
- The float layer: surfaces that sit above the page (`.hc-panel`, popovers,
  the ⌘K palette, the transcript comment card) use `--shadow-1..3` plus the
  `--edge-lit` 1px top edge. In light mode the shadows use `--shadow-ink`, a
  warm brown ink, never a cool near-black. SVG shapes that `box-shadow` cannot
  lift use `--drop-1`, the same shadow as a `drop-shadow()` filter.
- The selected-row accent bar (see Selection below).

### Surface roles

Panes in the maximized chat workspace use role tokens rather than raw
backgrounds, so each theme can order them on its own:

| Role | Use | Dark | Light |
| --- | --- | --- | --- |
| `--surface-recessed` | Projects/history sidebar | `bg` | `bg-1` |
| `--surface-well` | Changes code panel | `bg` | `bg-1` |
| `--surface-page` | The chat column, one step up | `bg-2` | paper white |

The panes sit on `--color-canvas`, separated by 8px gutters instead of
hairlines. The sidebar has no border or shadow; the chat column is raised one
step (`--shadow-1` plus `--edge-lit`); Changes is a rounded well inside it.

### Hover and selection

- `--color-bg-hover` is the hover for list rows on recessed or page surfaces.
  It is a plain `rgba`, because `color-mix` hover backgrounds flash in
  WKWebView.
- `--color-bg-hover-raised` is the stronger hover (about 8% fg) for raised
  controls: cards, chips, composer controls, header icon buttons and tabs.
- A selected row uses the shared treatment: `--color-selection` background
  plus `box-shadow: inset 3px 0 0 var(--color-accent)` on the leading edge.
  Keep the hover state identical to the selected state so selection does not
  flicker under the pointer.

### Focus

Focus styling goes through the shared halo block in `index.css`: mark the
element with `data-focus-halo` (`within` for composite fields such as the
composer, `surface` for floating surfaces, `overlay` for full-bleed viewers,
`none` to opt out). Don't add per-component focus rings.

### The glow rule

A glow is permitted **only when an entity is actively executing**. This includes:

- Status pills with `step_name === "in_progress"` (currently using `animate-pulse-glow`).
- Active-now timeline nodes in `ExecutionHistory` and the workflow pipeline.
- Animated React Flow edges representing in-flight workflow transitions (`signal-flow`).
- Indicator dots for daemons or runners in their live state.
- The active-route bar in the sidebar (live "where am I" cue).

Glow is **not** permitted for:

- Hover (use `bg-bg-hover` or `border-border-strong`).
- Selection (use `ring-1 ring-primary` outline or accent left-border).
- Focus on inputs (use `border-primary`).
- Emphasis on cards or panels.
- Decoration of any kind.

The CSS variables `--shadow-glow`, `--shadow-glow-sm`, and the keyframes `pulse-glow` / `signal-flow` exist for these running-state cases and should not be applied elsewhere.

## Shapes

| Token | Value | Use |
| --- | --- | --- |
| `radius-sm` | `3px` | Chips, micro-elements, inline code |
| `radius-md` | `5px` | Buttons, inputs, menu items, popovers |
| `radius-lg` | `8px` | Cards, panels, composer |
| `radius-xl` | `12px` | Command palette, large overlays |
| `radius-full` | `9999px` | Status pills, indicator dots |

Avoid sizes outside this scale.

## Components

### `<SpineRule />`

A horizontal divider rendered as a row of short equal-length segments separated by gaps (default: 7 segments, 24px each, 6px gap, 1px tall, in `border` tone). Used between major sections instead of a continuous `<hr>` or a heavy `border-b`.

```tsx
<SpineRule />            // default 7 segments
<SpineRule segments={5} />
```

It is what gives the panel structural rhythm without drawing an unbroken line. Use it between major zones (e.g. between `ACCEPTANCE CRITERIA` and `PROGRESS` in the task detail panel). Continuous 1px borders read as "every section is the same weight" — SpineRule says "this is the next zone."

### Buttons

A button group has at most **one** accent-filled button — the primary action. All others demote to outline or ghost.

```text
[ Run Step ]   [ ⚡ Run Workflow ]   [ Chat ]   [ Delete ]
   outline           solid accent     ghost     ghost (red on hover)
```

For the task detail panel:

- **Run Workflow** is the primary action (the whole point is to move the task through the workflow). Solid accent background, `on-primary` text.
- **Run Step** is secondary (running just one step is a manual override). Neutral outline using `border-border-strong`.
- **Chat** is tertiary. Ghost button — no border, `text-text-secondary`, hover lifts to `text-text-primary` with `bg-bg-hover`.
- **Delete** is destructive. Ghost neutral by default — turns `error` red only on hover. Never destructive-colored at rest.

### Inputs

Input sits on `bg-tertiary` with a 1px `border`. Focus uses the shared halo (see Focus); no glow and no extra shadow. Placeholder text is `text-muted`.

### Cards and surfaces

`.card` uses `bg-secondary`, 1px `border`, `radius-lg`, generous padding. Hover lifts the border to `border-strong`. No shadow, no accent border on hover.

### Status pills (steps and validation)

Step pills (`backlog`, `todo`, `in_progress`, `pending_review`, `done`, `rejected`) and validation pills (`human`, `machine`) use the corresponding status color at 10% opacity background + full status color text:

```text
.bg-warning/10 .text-warning   // in_progress, human
.bg-success/10 .text-success   // done, met
.bg-info/10    .text-info      // pending_review, machine
.bg-error/10   .text-error     // rejected, not_met
.bg-bg-tertiary .text-text-muted // backlog, pending
```

The `in_progress` pill additionally gets `animate-pulse-glow` because the entity is *running*. No other status pill glows.

### Acceptance criteria checkbox

Three states:

- **Pending**: hollow circle, 1px `border-border-strong`, no fill.
- **Met**: filled `bg-success/20` with checkmark in `success`.
- **Not met**: filled `bg-error/20` with X in `error`.

### Workflow zone (pipeline view)

Workflows in the pipeline view use a dashed border (`2px dashed`) in `rgba(100, 116, 139, 0.4)` by default. When highlighted via a transition click, the dashed border switches to the accent. **No solid ring is added** — the dashed accent border alone communicates the highlight. Selected workflows (clicked directly) keep a solid `ring-2 ring-primary` to distinguish active selection from transition-highlight.

## Chrome reduction patterns

These keep surfaces minimal while every capability stays reachable.

- **Overflow menu.** Pane headers show at most title, context chip, status
  dot, one or two contextual toggles (shown inline only while open or busy),
  Stop, `⋯`, and close. Everything else lives in the `⋯` menu
  (`molecules/OverflowMenu`), which closes on selection, outside click and
  Escape, and returns focus to its trigger.
- **Model chip.** The composer shows a permission chip and a single model chip
  (`provider · model · effort`). Provider, model, effort and speed pickers live
  in the chip's popover. A stale or unsupported choice marks the chip with
  `warn` instead of adding inline controls.
- **Quiet activity rows.** Completed background work and notices render as a
  single muted sans line with a flat dot. Only warnings get a boxed wash; only
  live rows (thinking, subagent progress) get the accent ember.
- **⌘K palette.** One keyboard entry point for pages, tasks, chats and app
  actions, with scope tabs and a key-hint footer.

## Layout and spacing

Spacing follows Tailwind's 4px base unit. Common values used here:

- `1` (0.25rem), `2` (0.5rem), `3` (0.75rem), `4` (1rem), `6` (1.5rem), `8` (2rem), `12` (3rem).

For the task detail panel:

- Inter-section gap: rendered as `py-3 px-4` around the `SpineRule`, giving ~36px of breathing between major zones.
- Within sections (e.g. `SpecSection`), label-to-content gap is `space-y-2` (8px) and group-to-group gap is `space-y-5` (20px) so each label/content pair reads as a cohesive unit.
- Inside `CollapsibleSection`, the body content has `pb-6` so the section feels closed off before the SpineRule.

## Motion

Transitions use `--t-fast` (100ms), `--t-base` (180ms) or `--t-slow` (280ms) with `--ease`. Hover states are tonal background or text color shifts only. Size transitions must switch off while the user drives the size directly (panel drag, window resize), or the surface trails the pointer; `.hc-panel[data-resizing]` does this for the chat panel.

Functional motion is permitted:

- `animate-pulse-glow` on running entities.
- `animate-signal-flow` on dashed React Flow edges representing live transitions.
- `animate-flash-border` for assignment / arrival highlights (one-shot, ~2s).
- `animate-fade-in-up` for list mounts.

Decorative motion is not permitted: no scale-on-hover, bounce, spring, glow-on-hover, particle effects, gradients, aurora, or animated decorative shapes.

## Don'ts

- Don't add glow except for live-execution semantics — see the glow rule above.
- Don't introduce a fourth type family, and don't use Newsreader for chrome (titles, labels, menus).
- Don't use Geist for IDs / timestamps / numerics, or JetBrains Mono for labels and body copy.
- Don't add shadow-based elevation to in-flow cards, buttons, or inputs; shadows belong to the float layer.
- Don't add hover glow, glow-border, or shadow-glow to anything that is not actively running.
- Don't use the dot-grid background (`.neural-grid` is intentionally a no-op now — references are kept only to avoid touching every page; do not add new ones).
- Don't lighten or desaturate `accent` between themes — the hex is identical in both.
- Don't add a third accent color. The palette ships one. Status colors are semantic, not decorative.
- Don't use pure white or pure black for text or backgrounds. Use the warm neutrals defined above.
- Don't put more than one accent-filled element per visual cluster (button row, header, badge group). Demote the rest to outline or ghost.

## Implementation notes

- Tokens live in `crates/gui/src/index.css` under `@theme { ... }`. Tailwind v4 auto-generates utility classes from the `--color-*` variables — so `bg-primary`, `text-text-primary`, `border-border-strong` etc. are all available without extra config.
- `--color-primary` aliases `--color-accent`. Prefer `primary` for filled actions and `accent` for indicators.
- The `SpineRule` component lives at `crates/gui/src/components/SpineRule.tsx`.
- The light theme is selected by adding the `light` class to `<html>`. See `hooks/useTheme.ts`.
