# Vertebrae (vtb) CLI Guide

Vertebrae (`vtb`) is a CLI client for the Sacrum GraphQL API. It provides structured workflows for planning, triaging, implementing, and reviewing work through a terminal interface.

> **Backend:** See [System Overview](system-overview.md) for how vtb fits into the broader Sacrum architecture.

This entrypoint is intentionally short. The maintained command guide is split by topic so each command family can be validated and updated independently.

## Start Here

| Page | Use it for |
|------|------------|
| [Project Setup](vtb-guide/project-setup.md) | `vtb init`, project configuration, and live CLI help validation |
| [Core Concepts and Workflow](vtb-guide/overview.md) | task hierarchy, workflow position, short IDs, JSON output, end-to-end usage |
| [Tasks](vtb-guide/tasks.md) | create, triage, list, show, update, delete, archive, and checklist commands |
| [Artifacts](vtb-guide/artifacts.md) | create, list, inspect, update, look up, and delete artifact files |
| [Sections](vtb-guide/sections.md) | task documentation sections, section types, checklist criteria, edit/remove behavior |
| [Dependencies](vtb-guide/dependencies.md) | `depend`, `undepend`, `blockers`, and `path` |
| [Code References](vtb-guide/references.md) | `ref`, `refs`, `unref`, and `criterion-ref` |
| [Workflows](vtb-guide/workflows.md) | workflow CRUD, assignment, transitions, and task movement rules |
| [Steps](vtb-guide/steps.md) | step CRUD, step types, output schemas, agents, skills, and provider selection |
| [Runs and TaskRuns](vtb-guide/execution.md) | `run`, `start-taskrun`, and `stop-taskrun` |

## Installed Guide Assets

Downstream projects should install this entrypoint plus every page under `docs/vtb-guide/`. The entrypoint keeps navigation stable, while the split pages carry the detailed command examples that should be checked against live `vtb --help` and `vtb <command> --help` output.

## Command Reference

The detailed command reference now lives with each topic page:

- [Project setup commands](vtb-guide/project-setup.md)
- [Task lifecycle commands](vtb-guide/tasks.md)
- [Section commands](vtb-guide/sections.md)
- [Dependency commands](vtb-guide/dependencies.md)
- [Code reference commands](vtb-guide/references.md)
- [Workflow commands](vtb-guide/workflows.md)
- [Step commands](vtb-guide/steps.md)
- [Run commands](vtb-guide/execution.md)
