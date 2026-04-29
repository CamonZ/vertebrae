---
version: alpha
name: Articulated (Vertebrae GUI)
description: Vertebrae's desktop GUI design system. Adopted from Sacrum's Articulated with one deliberate exception — glow is reserved as a semantic signal for live execution state.
colors:
  bg: "#0a0a0a"
  surface: "#111111"
  surface-raised: "#161616"
  border: "#1f1f1f"
  border-strong: "#2a2a2a"
  text-primary: "#f4f1ec"
  text-secondary: "#b8b5af"
  text-muted: "#6f6c66"
  accent: "#ff5c2e"
  accent-hover: "#e84a1e"
  accent-fg: "#0a0a0a"
  success: "#22c55e"
  warning: "#eab308"
  error: "#ef4444"
  info: "#a78bfa"
  bg-light: "#f7f4ee"
  surface-light: "#ffffff"
  border-light: "#e6e1d7"
  border-strong-light: "#c9c3b5"
  text-primary-light: "#0a0a0a"
  text-secondary-light: "#4a4742"
  text-muted-light: "#807c75"
typography:
  family-sans: "Geist"
  family-mono: "Geist Mono"
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.75rem"
  pill: "9999px"
---

# Articulated, applied to the Vertebrae GUI

The Vertebrae desktop GUI uses Sacrum's [Articulated](../sacrum/DESIGN.md) design system as its chassis: monochrome warm neutrals, a single persimmon accent, Geist + Geist Mono, structural rhythm built from borders and tonal surface shifts.

There is **one deliberate divergence** from strict Articulated. Articulated says no shadows, no glow, anywhere. The GUI keeps a tightly-scoped glow utility because the product's job is to show workflow execution as it happens — and a flat surface cannot communicate "this thing is moving right now" the way a soft pulse can.

The rule that resolves the tension is simple:

> **Glow means running. Nothing else.**

Static UI is flat. Hover, selection, focus, and emphasis are conveyed through borders and tonal shifts. A glow appears only on entities that are actively executing — a step pill in the in-progress state, a daemon-active timeline node, an animated React Flow edge for a transition currently flowing. The signal stays meaningful because nothing else competes with it.

## Colors

The palette is identical to Articulated's. A single persimmon accent at the same hex in both themes; warm neutrals (never pure black or pure white) for backgrounds and text; status colors are designed per-theme to remain accessible.

### Dark theme (default)

| Token | Hex | Role |
| --- | --- | --- |
| `bg-primary` | `#0a0a0a` | Page background |
| `bg-secondary` | `#111111` | Cards, panels |
| `bg-tertiary` / `bg-elevated` | `#161616` | Raised surfaces |
| `border` | `#1f1f1f` | Standard 1px divider |
| `border-strong` | `#2a2a2a` | Emphasized divider, hover state |
| `text-primary` | `#f4f1ec` | Body, headings |
| `text-secondary` | `#b8b5af` | Secondary copy |
| `text-muted` | `#6f6c66` | De-emphasized labels, timestamps |

### Light theme

| Token | Hex | Role |
| --- | --- | --- |
| `bg-primary` | `#f7f4ee` | Page background |
| `bg-secondary` / `bg-elevated` | `#ffffff` | Cards, panels |
| `border` | `#e6e1d7` | Standard divider |
| `border-strong` | `#c9c3b5` | Emphasized divider |
| `text-primary` | `#0a0a0a` | Body, headings |
| `text-secondary` | `#4a4742` | Secondary copy |
| `text-muted` | `#807c75` | De-emphasized labels |

### Shared

| Token | Hex | Role |
| --- | --- | --- |
| `accent` (primary) | `#ff5c2e` | Primary actions, focus, running-state glow, the one accented element per cluster |
| `accent-hover` | `#e84a1e` | Hover state — darker, never lighter |
| `success` | `#22c55e` | Met / completed |
| `warning` | `#eab308` | In-progress route badge, human-validation badge |
| `error` | `#ef4444` | Failure, destructive hover |
| `info` | `#a78bfa` | Pending review, neutral informational |

`--color-primary` and `--color-accent` resolve to the same persimmon. The legacy split into amber + orange has been collapsed to a single accent per Articulated's "one accent" rule.

Theme is toggled by adding `light` or `dark` class to `<html>` (see `hooks/useTheme.ts`). The default is dark.

## Typography

Two families, no third. Loaded weights: Geist 400/500/600/700; Geist Mono 400/500.

| Role | Family | Use |
| --- | --- | --- |
| `body` | Geist | Default body copy |
| `body-sm` | Geist | Secondary body |
| `heading` | Geist 600 | Card and section titles |
| `label` (caps + tracking) | Geist Mono | Section labels (`GOAL`, `PROMPT`, `OVERVIEW`) |
| `mono` | Geist Mono | IDs, timestamps, numerics, step counts, model names, code, file paths, ticket short-IDs |
| `caption` | Geist | Footnotes, fine print |

**Mono is reserved for identifiers and numerics.** This is enforced for:

- Task and ticket short-IDs (`4e4bbbde`, `dd32dd28`)
- Timestamps (`Apr 2 at 06:47 AM`, `4/27/2026, 10:16:57 AM`)
- Model identifiers (`haiku`, `sonnet`, `opus`)
- Step ordering (`1`, `2`, `3` in step badges)
- Section counts (`(0)`, `0/2`, `0%`)
- Step type values (`execute`, `wait_children`)
- File paths and code snippets

Body content (titles, descriptions, goal/criterion text) stays in Geist Sans. The PROMPT block in step configuration is the canonical case for Mono on a raised surface — it contains code and Liquid templating, not prose.

## Hierarchy and elevation

Hierarchy is composed from:

1. **1px borders** in `border` or `border-strong`.
2. **Tonal background shifts** — `bg-primary` → `bg-secondary` → `bg-tertiary` (~6 lightness steps each).
3. **The SpineRule divider** between major sections (see Components).

**No box-shadow for elevation.** Cards, buttons, modals, inputs do not use shadow to suggest depth. The only allowed shadows are:

- The semantic glow utilities scoped to running-state (see below).
- Focus-visible rings (2px accent at 2px offset) for keyboard accessibility.

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
| `radius-sm` | `0.375rem` | Chips, dots, micro-elements |
| `radius-md` | `0.5rem` | Buttons, inputs, badges |
| `radius-lg` | `0.75rem` | Cards, panels, surfaces |
| `radius-full` | `9999px` | Status pills, indicator dots |

`radius-xl` and `radius-2xl` are deprecated — collapse new components to the four sizes above.

## Components

### `<SpineRule />`

A horizontal divider rendered as a row of short equal-length segments separated by gaps (default: 7 segments, 24px each, 6px gap, 1px tall, in `border` tone). Used between major sections instead of a continuous `<hr>` or a heavy `border-b`.

```tsx
<SpineRule />            // default 7 segments
<SpineRule segments={5} />
```

It is what gives the panel structural rhythm without drawing an unbroken line. Use it between major zones (e.g. between `ACCEPTANCE CRITERIA` and `PROGRESS` in the task detail panel). Continuous 1px borders read as "every section is the same weight" — SpineRule says "this is the next zone."

### Buttons

A button group has at most **one** persimmon-accented button — the primary action. All others demote to outline or ghost.

```text
[ Run Step ]   [ ⚡ Run Workflow ]   [ Chat ]   [ Delete ]
   outline           solid persimmon     ghost     ghost (red on hover)
```

For the task detail panel:

- **Run Workflow** is the primary action (the whole point is to move the task through the workflow). Solid persimmon background, `accent-fg` text.
- **Run Step** is secondary (running just one step is a manual override). Neutral outline using `border-border-strong`.
- **Chat** is tertiary. Ghost button — no border, `text-text-secondary`, hover lifts to `text-text-primary` with `bg-bg-hover`.
- **Delete** is destructive. Ghost neutral by default — turns `error` red only on hover. Never destructive-colored at rest.

### Inputs

Input sits on `bg-tertiary` with a 1px `border`. Focus changes the border to `primary` only — no ring, no glow, no shadow. Placeholder text is `text-muted`.

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

Workflows in the pipeline view use a dashed border (`2px dashed`) in `rgba(100, 116, 139, 0.4)` by default. When highlighted via a transition click, the dashed border switches to persimmon `#ff5c2e`. **No solid ring is added** — the dashed accent border alone communicates the highlight. Selected workflows (clicked directly) keep a solid `ring-2 ring-primary` to distinguish active selection from transition-highlight.

## Layout and spacing

Spacing follows Tailwind's 4px base unit. Common values used here:

- `1` (0.25rem), `2` (0.5rem), `3` (0.75rem), `4` (1rem), `6` (1.5rem), `8` (2rem), `12` (3rem).

For the task detail panel:

- Inter-section gap: rendered as `py-3 px-4` around the `SpineRule`, giving ~36px of breathing between major zones.
- Within sections (e.g. `SpecSection`), label-to-content gap is `space-y-2` (8px) and group-to-group gap is `space-y-5` (20px) so each label/content pair reads as a cohesive unit.
- Inside `CollapsibleSection`, the body content has `pb-6` so the section feels closed off before the SpineRule.

## Motion

All transitions use `120ms` (`--transition-fast`) or `200ms` (`--transition-normal`) ease-out. Hover states are tonal background or text color shifts only.

Functional motion is permitted:

- `animate-pulse-glow` on running entities.
- `animate-signal-flow` on dashed React Flow edges representing live transitions.
- `animate-flash-border` for assignment / arrival highlights (one-shot, ~2s).
- `animate-fade-in-up` for list mounts.

Decorative motion is not permitted: no scale-on-hover, bounce, spring, glow-on-hover, particle effects, gradients, aurora, or animated decorative shapes.

## Don'ts

- Don't add glow except for live-execution semantics — see the glow rule above.
- Don't introduce a third type family or a serif accent.
- Don't use Geist Sans for IDs / timestamps / numerics, or Geist Mono for body copy.
- Don't add shadow-based elevation to cards, modals, buttons, or inputs.
- Don't add hover glow, glow-border, or shadow-glow to anything that is not actively running.
- Don't use the dot-grid background (`.neural-grid` is intentionally a no-op now — references are kept only to avoid touching every page; do not add new ones).
- Don't lighten or desaturate `accent` between themes — the hex is identical in both.
- Don't add a third accent color. The palette ships one. Status colors are semantic, not decorative.
- Don't use pure white or pure black for text or backgrounds. Use the warm neutrals defined above.
- Don't put more than one persimmon-accented element per visual cluster (button row, header, badge group). Demote the rest to outline or ghost.

## Implementation notes

- Tokens live in `crates/gui/src/index.css` under `@theme { ... }`. Tailwind v4 auto-generates utility classes from the `--color-*` variables — so `bg-primary`, `text-text-primary`, `border-border-strong` etc. are all available without extra config.
- Both `--color-primary` and `--color-accent` resolve to persimmon. New components should prefer `primary` for clarity; `accent` aliases remain for migration compatibility.
- The `SpineRule` component lives at `crates/gui/src/components/SpineRule.tsx`.
- The light theme is selected by adding the `light` class to `<html>`. See `hooks/useTheme.ts`.
- Reference: Sacrum's full Articulated spec at `../sacrum/DESIGN.md`.
