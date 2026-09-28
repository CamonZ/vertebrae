# Overlap checks

Purpose: know what the backend proves when a route config is saved, and what can still fail at runtime.
Use this when: a save is rejected, or a saved route fails during a run.

## At save time
- Structure and types: `route_config_invalid`, `route_operand_type_mismatch`,
  `route_reference_unknown` (ref not in a predecessor schema).
- Targets: `route_target_invalid` (no such step transition / workflow transition).
- Overlap: rules are normalized and compared pairwise over enum values, numeric
  intervals (clamped by the schema) and `task.level`. An intersection is
  `route_config_ambiguous`, reported at the later rule.
- Coverage: for rules on closed enums and `task.level`, every combination must
  match a rule or the default exists, else `route_config_uncovered`.
- Default rule: rules on anything other than required string enums need a `default`.

## Not proven at save time
Conjunctions that read `task.tags` or `execution.step_visit_count` (and very
large rule sets) are not modeled. Two such rules can both match at runtime:
`route_ambiguous_match` fails the run.

## Doing it
Make tag and visit-count rules disjoint yourself, e.g. pair
`contains "security"` with `not contains "security"`, or `lte 2` with `gt 2`.

## Related
[Partitions](partitions.md) · [Failure table](../../../debugging/failure-table.md)
