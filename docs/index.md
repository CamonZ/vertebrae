# Documentation Index

This index is the source of truth for project documentation entrypoints.

## Start Here

| Document | Use For |
|----------|---------|
| [Project Overview](project-overview.md) | Workspace layout, crates, build commands, dependency summary |
| [Architecture](architecture.md) | Rust crate architecture, service traits, Sacrum GraphQL client, GUI, daemon |
| [System Overview](system-overview.md) | Full Vertebrae + Sacrum domain model and AI workflow execution loop |
| [vtb Guide](vtb-guide.md) | CLI guide entrypoint with maintained pages for tasks, dependencies, sections, workflows, steps, and runs |
| [Sacrum Config](SACRUM_CONFIG.md) | Global config file, project matching, and environment overrides |
| [GUI Development](gui-development.md) | Tauri + React development, scripts, frontend state, real-time sync |
| [Testing](testing.md) | Local test commands, coverage, linting, and acceptance-test constraints |
| [Git Hooks](git-hooks.md) | Pre-commit hook setup and checks |
| [Skills Audit](skills-audit.md) | Installed skill inventory, live-help validation policy, and Sacrum parity findings |

## Fast Paths

- Need to understand what the system does: read [System Overview](system-overview.md), then [Architecture](architecture.md).
- Need to run or script `vtb`: read [vtb Guide](vtb-guide.md), then [Sacrum Config](SACRUM_CONFIG.md).
- Need to work on the GUI: read [GUI Development](gui-development.md), then [Architecture](architecture.md).
- Need to verify changes: read [Testing](testing.md) and [Git Hooks](git-hooks.md).
