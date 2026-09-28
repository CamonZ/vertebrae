# Partitions

Purpose: design rules that select exactly one outcome for every input.
Use this when: writing rules, choosing thresholds, deciding on a default.

## How it works
`exactly_one` means rules must not overlap: rule order is irrelevant, and two
matches fail the run (`route_ambiguous_match`). No match uses `default`, or
fails with `route_no_match`.

## Design method
1. Partition first on the broadest closed axis: `task.level`, or an enum
   field such as a `choice` answer or a verdict. Each value gets its own rule
   (or rule group).
2. Refine within a partition with thresholds, combined via `all`.
3. Give every open or numeric axis a `default`: thresholds, tags and visit
   counts cannot be enumerated.

A conjunction like `task.level == "epic" and probabilities.foo >= 0.9` leaves
a blind spot: epics below 0.9 and every non-epic. Either add rules that cover
the complements, or rely on `default`, deliberately.

## When a default is required
The backend requires `default` unless every rule reads only required string enums
(and `task.level`) and together they cover every combination. Closed enums
fully covered: no default. Any threshold, tag or visit count: default.

## Example (bug triage gate)
- `fix_now`: `reproducible.noul gte 0.8` and `blocking.noul gte 0.8`
- `backlog`: `blocking.noul lte 0.2`
- default: `needs_info`
Check the pairs: can a case satisfy both rules? `blocking >= 0.8` and `<= 0.2`
cannot, so they are disjoint.

## Related
[Overlap checks](overlap-checks.md) · [Routable fields](../structured_inference/routable-fields.md)
