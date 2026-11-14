# Phases of a migration

`phases` tells a migration the story moves through (today → … → target):
the diagram changes as the beats advance. Presence, overrides and band
maps work as for [named arrangements](changes.md#named-arrangements).

## Format and marks

`phases: [today, p1, p2, target]` (names or `{name, label}`) instead of
`arrangements`: the same `in`, `arrangement` overrides and band maps, but the
story picks the phase. Beats start phases in order with `phase:` (see
[story](story.md)); there is no `baseline`.

Each phase is marked against the phase before it, not against the first:
what that step of the migration adds, changes or removes. A part added in
p1 is absent in today, marked added in p1 and unchanged from p2 on; a part
removed in p2 is drawn until p2, ghosts out marked removed in p2, and is
gone after. An override is changed where it reads differently from the
previous phase's, so repeat an override in later phases to keep the part
unchanged there. The first phase draws no marks; a beat's steps are listed
+ or − against the phase before the beat's.

Every phase's timeline replays the whole story (each beat's steps in its
own phase), so cards are where the story left them when a phase begins.
Layout is one layout over every phase: parts keep their place throughout.
Band meters count the whole story once (no per-phase footnote). See the
[migration recipe](recipes/migration.md).

## In the player

With phases there is no selector: a phase strip over the beats shows every
phase in order and marks the current one, and the beats are grouped under
their phase. Playing or stepping into a beat of another phase morphs to it
once, and playback holds on the beat's start until the morph ends; stepping
back across a boundary restores the earlier phase. Seeking (Home/End, the
beat list, `1`–`9`) jumps straight to the beat's phase with one morph, not
one per phase passed. Activating a phase in the strip, or `b`/`⇧B`, seeks to
that phase's first beat.

[Authoring index](../machine-diagrams.md).
