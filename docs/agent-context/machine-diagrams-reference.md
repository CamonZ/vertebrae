# Machine-diagram part, verb and attachment reference

Field contracts transcribed from the shipped JSON schema and registries;
verb explanations checked against their compile implementations. Start with
the [authoring guide](machine-diagrams.md) and [recipes](machine-diagrams-recipes.md).

Each part's job is its selection guide. A verb belongs to its part, not to a
global vocabulary. Field contracts use JSON: required is explicit, default
is filled when omitted, min/max are inclusive, enum lists accepted strings.
An absent default leaves the field unset. For attachments, also read
[common fields and cross-field constraints](machine-diagrams/evidence.md).

- [Actors](machine-diagrams/reference/actors.md): per-kind fields and semantics.
  Load when: authoring actors mechanisms.
- [Attachments](machine-diagrams/reference/attachments.md): per-kind fields and semantics.
  Load when: authoring attachments mechanisms.
- [Compute](machine-diagrams/reference/compute.md): per-kind fields and semantics.
  Load when: authoring compute mechanisms.
- [Data and state](machine-diagrams/reference/data-and-state.md): per-kind fields and semantics.
  Load when: authoring data and state mechanisms.
- [Distributed systems](machine-diagrams/reference/distributed-systems.md): per-kind fields and semantics.
  Load when: authoring distributed systems mechanisms.
- [Event sourcing](machine-diagrams/reference/event-sourcing.md): per-kind fields and semantics.
  Load when: authoring event sourcing mechanisms.
- [Messaging and flow control](machine-diagrams/reference/messaging-and-flow-control.md): per-kind fields and semantics.
  Load when: authoring messaging and flow control mechanisms.
- [Observability](machine-diagrams/reference/observability.md): per-kind fields and semantics.
  Load when: authoring observability mechanisms.
- [Policy](machine-diagrams/reference/policy.md): per-kind fields and semantics.
  Load when: authoring policy mechanisms.
- [Topology and lifecycle](machine-diagrams/reference/topology-and-lifecycle.md): per-kind fields and semantics.
  Load when: authoring topology and lifecycle mechanisms.
- [Vertebrae workflows](machine-diagrams/reference/vertebrae-workflows.md): per-kind fields and semantics.
  Load when: authoring vertebrae workflows mechanisms.

When vocabulary changes, update the relevant reference page, guide and recipes.
The authoringDocs test enumerates schema kinds and per-kind verbs and fails
when their entries are missing; it also validates and renders every recipe.
