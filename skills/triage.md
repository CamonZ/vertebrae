---
description: Triage a ticket from backlog to todo with validation
---

# /triage

Move a ticket from backlog to todo, ensuring it's properly defined.

## When to use
- After refining a backlog ticket with all required sections
- When ready to make a ticket available for work
- After `vtb ready` shows backlog items to triage

## Command

```bash
vtb triage <task-id>
```

## Required sections (must have)

Before triaging, ensure the ticket has:

| Section | Minimum | Purpose |
|---------|---------|---------|
| `testing_criterion` | 2 | At least 1 unit + 1 integration test criterion |
| `step` | 1 | Implementation steps |
| `constraint` | 2 | Architectural guidelines + test quality rules |

## Strongly encouraged (warnings)

| Section | Purpose |
|---------|---------|
| `anti_pattern` | What NOT to do |
| `failure_test` | Expected error scenarios |

## Recommended (notes)

- `goal` - Clear objective
- `context` - Background information
- `current_behavior` / `desired_behavior` - For bugs/changes

## Adding sections

```bash
# Add testing criteria
vtb section <id> testing_criterion "UNIT: Validates input correctly"
vtb section <id> testing_criterion "INTEGRATION: End-to-end flow works"

# Add steps
vtb section <id> step "Implement the validation logic"
vtb section <id> step "Add error handling"

# Add constraints
vtb section <id> constraint "Use repository pattern"
vtb section <id> constraint "No weak assertions in tests"

# Add anti-patterns
vtb section <id> anti_pattern "Don't hardcode values"

# Add failure tests
vtb section <id> failure_test "Invalid input returns error"
```

## Workflow

```bash
# 1. See what's ready to triage
vtb ready

# 2. Check ticket details
vtb show <task-id>

# 3. Add missing sections
vtb section <task-id> testing_criterion "..."
vtb section <task-id> step "..."

# 4. Triage when ready
vtb triage <task-id>

# 5. Now it appears in "ready to work"
vtb ready
```
