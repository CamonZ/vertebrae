---
description: List all sections for a task
---

# /sections

List all sections for a task, optionally filtered by type. Sections are grouped into desired behavior (positive space) and undesired behavior (negative space).

## Usage

```bash
# List all sections
vtb sections <task-id>

# Filter by type
vtb sections <task-id> --type step
vtb sections <task-id> --type testing_criterion
vtb sections <task-id> --type constraint
```

## Section types

**Positive space (desired behavior):** goal, context, current_behavior, desired_behavior, step, testing_criterion

**Negative space (undesired behavior):** anti_pattern, failure_test, constraint

## Related commands

```bash
vtb section <task-id> step "Do this"              # Add a section
vtb unsection <task-id> goal                      # Remove single-instance
vtb unsection <task-id> step --index 2            # Remove by ordinal
```
