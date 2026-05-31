# Sections

## Documenting Tasks with Sections

Sections add structured content to tasks. They are critical for triage.

`vtb section` accepts the global `--json` flag and takes a case-insensitive task
ID, a section type, and non-empty content:

```bash
vtb section [--json] <id> <section-type> "content"
```

Single-instance section types replace the existing section of that type.
Multi-instance section types append a new section with a zero-based index.

### Section Types

| Type | Purpose | Cardinality |
|------|---------|-------------|
| `goal` | What this task achieves | Single |
| `context` | Background information | Single |
| `current_behavior` | How it works now (for bugs) | Single |
| `desired_behavior` | How it should work | Single |
| `checklist_item` | Trackable checklist with done/undone | Multiple |
| `constraint` | Requirements/limitations | Multiple |
| `testing_criterion` | How to verify success | Multiple |
| `anti_pattern` | What to avoid | Multiple |
| `failure_test` | Expected failure/edge cases | Multiple |

### Adding Sections

```bash
# Define the objective
vtb section <id> goal "Allow users to subscribe to real-time market data"

# Background context
vtb section <id> context "TWS provides tick-by-tick data via request ID subscriptions"

# Checklist items (trackable)
vtb section <id> checklist_item "Create RequestData struct with contract and tick_list fields"
vtb section <id> checklist_item "Implement binary serialization"
vtb section <id> checklist_item "Add response parsing in from_fields/1"
vtb section <id> checklist_item "Review API documentation"
vtb section <id> checklist_item "Update changelog"

# Constraints
vtb section <id> constraint "Must validate server version supports market data"
vtb section <id> constraint "All tests must use async: true"

# Testing criteria (at least 1 unit + 1 integration)
vtb section <id> testing_criterion "UNIT: RequestData.new/1 returns valid struct"
vtb section <id> testing_criterion "INTEGRATION: Full request/response cycle"

# Anti-patterns
vtb section <id> anti_pattern "Don't bypass Subscribable protocol with direct ETS writes"

# Failure tests
vtb section <id> failure_test "Invalid contract returns {:error, reason}"
```

### Viewing Sections

`vtb sections` lists the sections already attached to a task:

```bash
vtb sections [--json] [--type <SECTION_TYPE>] <id>
```

The command has one required positional argument, `<id>`, which is a
case-insensitive task ID. Without `--json`, output is grouped into desired and
undesired behavior using the section type categories above. Sections are sorted
by that group order, then by section type, then by their stored ordinal.

```bash
# List all sections
vtb sections <id>

# Filter by type
vtb sections <id> --type checklist_item
vtb sections <id> --type testing_criterion
vtb sections <id> --type constraint

# Emit machine-readable output
vtb sections <id> --type testing_criterion --json
```

`--type` accepts any value from the Section Types table above. Invalid section
types are rejected before the command runs and print the valid type list. With
`--json`, successful output contains `id`, `sections`, and `filter_type`;
`filter_type` is `null` when no filter was supplied.

### Editing and Removing Sections

```bash
# Edit a section in-place (type + 0-based index + new content)
vtb update <id> --edit-section checklist_item 0 "Updated checklist item"

# Remove a section (type + 0-based index)
vtb update <id> --remove-section checklist_item 0

# Remove single-instance types (no index needed)
vtb unsection <id> goal
vtb unsection <id> context

# Remove multi-instance types (index required)
vtb unsection <id> checklist_item --index 2
vtb unsection <id> testing_criterion --index 1

# Emit machine-readable output
vtb section <id> checklist_item "Update changelog" --json
```

### Checklist Items

Checklist items can be checked and unchecked to track progress:

```bash
# Mark checklist item #1 as done (1-based index)
vtb check-item <id> 1

# Uncheck item #2
vtb uncheck-item <id> 2

# Emit machine-readable output
vtb uncheck-item <id> 2 --json

# View checklist status via show
vtb show <id>
```

`vtb uncheck-item` accepts a case-insensitive task ID and a 1-based checklist
item index. The item must already be checked; otherwise the command fails with
`Validation failed: Checklist item <n> is not checked`.

Checklist items display with checkboxes:
```
Checklist Items:
  1. [x] Review API documentation
  2. [ ] Update changelog
```

---
