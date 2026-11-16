# Panel code surfaces

`components/shared/PanelCode.tsx` is the lazy entry point for bounded panel
source views and editors. `PierrePanelCode.tsx` owns Pierre's `File` and
`EditProvider`; it reuses `usePierreThemeOptions` (including selection CSS) and
the existing `diffWorkerPool`. It never selects a different backend per panel.
The installed Pierre version used for this change is 1.6.2.

## Source and draft contract

- Without `onChange`, the surface is read-only. Viewer source updates when its
  props change; no artifact persistence or template execution is involved.
- With `onChange`, `source` is a snapshot at mount. Changes report exact editor
  contents to the owning form. Do not feed a new `File` back on every keystroke:
  that would replace the document and lose history/selection.
- Remount on entity changes or explicit source replacement. `StepInspector`
  scopes its whole edit session to project generation, workflow and step.
  Refetching the same entity while editing leaves its draft intact. Failed
  saves keep the editor mounted; explicit save retains the existing validators
  and backend patch construction.
- `label` names the actual shadow-DOM textbox via Pierre's filename. Errors
  use `aria-invalid` and `aria-description` on that textbox, because an
  `aria-describedby` ID outside the shadow root cannot describe it.
- Loading and React load/render failures retain readable source; editable
  fallbacks remain native textareas. Views have bounded vertical scrolling and
  shrink inside narrow panels. Keyboard and selection behavior belongs to
  Pierre's editor, with an explicit visible focus outline. Tab and Shift+Tab
  navigate between form fields; Cmd/Ctrl+[ and Cmd/Ctrl+] indent code.

Artifact JSON pretty-printing and `formatRhaiScript` are display-only. Script
editors receive saved, unformatted Rhai; JSON viewers never write their
formatted strings back. Semantic schema trees remain schema trees.

## Language policy

Liquid and JSON are bundled by both installed backends (Highlights and
shiki-js). Liquid source is syntax-highlighted, never evaluated. A structured
state editor selects JSON or Liquid from its initial source; the language
remains pinned during that edit session to preserve its document/history.
Saving and reopening selects it again from saved source.

Neither installed backend bundles Rhai. Custom TextMate grammars require
Shiki; Highlights accepts only its bundled lexers. A per-panel switch to Shiki
would violate the application's one-backend-per-thread policy. The Rhai policy uses the bundled JavaScript lexer on both backends as a lexical
approximation: comments, quoted/backtick strings, numbers, operators and map
punctuation remain colored/readable. Rhai-specific keywords such as `fn` and
`loop` are not guaranteed to receive keyword colors. This is not a dedicated
Rhai grammar or a claim of complete syntax parity. The approximation is a documented language-support limitation.

Resolution evidence: installed `@pierre/highlights/dist/languages.d.ts`,
Shiki's bundled language catalog and Pierre's language registration/backend
implementations. The [Pierre highlighter documentation](https://diffs.com/docs#highlighters)
confirms that custom TextMate grammars require Shiki and only one backend can
be active per thread. Keep that thread/worker contract when adding languages.

## Migrated inventory

| Source surface | Presentation |
| --- | --- |
| `Artifacts/ArtifactPreviewBody.tsx` declared valid JSON | Read-only JSON, deterministic formatting; all raw diagnostics and specialized dispatch retained |
| `WorkflowAtlas/inspector/RhaiScript.tsx` | Read-only Rhai display formatting |
| `StepDetail/LiquidHighlight.tsx` | Read-only Pierre Liquid, replacing custom span tokenization |
| `WorkflowAtlas/inspector/StepInspector.tsx` prompt/script | Editable original source |
| Same inspector's output schema | JSON editor, semantic `SchemaTree` viewer retained |
| Same inspector's route config and persistence options | JSON viewer/editor |
| Same inspector's structured state/questions | JSON or Liquid state and JSON questions viewer/editor |
| `WorkflowAtlas/inspector/StructuredInferenceQuestions.tsx` | Shared structured editor, also used in workflow step creation |

Goal, name, provider, model, agents, skills and transitions remain ordinary
forms. Production source has no remaining `react-syntax-highlighter` imports;
its package and type package were removed together.

## Ranked follow-up candidates (not migrated)

Source inventory checked on 2026-11-16:

1. **High:** `ChatWindow/run/HumanInputGate.tsx` schema disclosure and
   `thread/EventRow.tsx` gate rejection verdict/submitted values. These are
   bounded, explicitly JSON read-only disclosures. Keep schema semantics and
   lazy disclosure behavior.
2. **High:** `thread/toolActivity/ToolActivityGroup.tsx` raw tool inputs/results.
   Keep disclosure lazy and distinguish known JSON from arbitrary tool output.
3. **Implemented follow-up:** `Artifacts/ArtifactPreviewBody.tsx` raw JSON/text/YAML paths.
   Diagnostic and metadata dispatch must remain visible; raw paths are also
   robust fallbacks when parsing or rendering fails.
4. **Medium:** `MachineDiagram/flow/attachmentRenderers.tsx` generic values,
   expressions and Before/After payloads. Use explicit language only when known;
   do not replace flow players or prose presentations.
5. **Defer pending reachability:** `molecules/ToolCallBlock.tsx` is referenced
   by `TaskDetail/conversation/EventRenderer.tsx`, itself referenced by
   `TaskDetail/ConversationLogViewer.tsx`. No production consumer of
   `ConversationLogViewer` was found by source search in this checkout; an
   exported molecule alone does not establish an active rendering path.

Chat fences, workspace editors and existing diffs already use Pierre. Their
viewport/loading/offscreen/plain-patch placeholders are performance mechanisms,
not migration targets. Markdown/prose, conversation layouts, statecharts,
flow players, schema trees and terminals retain their semantic renderers.

Read-only panel viewers show line numbers and wrap long source lines. Raw
artifact paths also use the shared viewer, retaining diagnostics and exact body
text. Filename inference uses Pierre's extension catalog, with unsupported
languages rendered as text on Shiki. Markdown stays on its semantic renderer
when metadata selects it; raw Markdown filenames remain plain source.
