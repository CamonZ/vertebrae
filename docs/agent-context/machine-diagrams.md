# Machine diagrams

Purpose: explain a system or a code change with a native, playable machine
diagram. Default to a completed `flow` fence in chat, containing YAML or JSON.
Use a saved flow artifact when the explanation belongs to a ticket or PR.
This is an authored explanation, not live observation or workflow execution.
For executable workflow structure use the [workflow docs](workflows/index.md);
for an XState statechart use [statecharts](statecharts.md).

Read the [part and verb reference](machine-diagrams-reference.md) for exact
kind names, ports, props, arguments and attachment fields. Read the
[worked recipes](machine-diagrams-recipes.md) for complete copyable examples.

## Authoring procedure

1. Identify the question and the concrete input card that answers it. Inspect
   the relevant code or run before making claims about its behavior.
2. Choose the smallest set of parts whose jobs explain the mechanism. Use
   the reference's job line to choose each part; its verbs define what it can
   demonstrate. A label renames an instance, never its registered kind or ports.
3. Give parts, rails and cards stable IDs. Connect real port names, then write
   a few beats: one event or consequence per caption, with steps underneath.
4. Leave positions absent for ELK layout. Give evidence its honest status.
   Keep chat fences at most 240 lines; split a large explanation into levels
   or artifacts. The chat renderer leaves longer fences as code.
5. Run `vtb flow validate <file>` and fix every `path: message` line until it
   exits 0; it runs the viewer's own compiler offline. Replay the story,
   inspect payloads, and for a change toggle both arrangements at the same
   beat. Check that captions describe the compiled result, not invent it.

## Read only the needed topic

- [Format](machine-diagrams/format.md): root objects, IDs, layout and extensions.
  Load when: starting a spec or fixing its shape.
- [Choosing parts](machine-diagrams/choosing-parts.md): mechanisms and families.
  Load when: deciding which part explains the system.
- [Parts, verbs and attachments](machine-diagrams-reference.md): exact vocabulary and field contracts.
  Load when: choosing a kind, port, prop, verb argument or attachment field.
- [Story](machine-diagrams/story.md): verbs, beats, captions and sequencing.
  Load when: animating a mechanism or checking retry/compensation semantics.
- [Cards](machine-diagrams/cards.md): tokens, identity and payloads.
  Load when: declaring inputs and following results.
- [Changes](machine-diagrams/changes.md): Before/After, named arrangements (options A, B…) and marks.
  Load when: inspecting or explaining a PR, or comparing arrangements or design options.
- [Band](machine-diagrams/band.md): situation rows and compile-derived meters.
  Load when: summarising behavior across beats.
- [Evidence](machine-diagrams/evidence.md): attachment choice and honest labels.
  Load when: supporting a claim with code, measurements or tests.
- [Drill-down](machine-diagrams/drill.md): nested specs and how the viewer opens them.
  Load when: adding a deeper explanation behind a part.
- [Artifacts](machine-diagrams/artifacts.md): saving, attaching and embedding.
  Load when: persisting an explanation for a ticket or PR.
- [Recipes](machine-diagrams-recipes.md): principles for explaining code, plus system, change and drill examples.
  Load when: explaining an open or merged PR or a part of the system, or copying a working spec.
- [Diagnostics and maintenance](machine-diagrams/maintenance.md): errors, the validator bundle and doc limits.
  Load when: fixing a spec or adding vocabulary.
