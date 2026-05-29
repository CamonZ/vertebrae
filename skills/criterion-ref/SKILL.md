---
name: criterion-ref
description: Add a code reference to a testing criterion
---

# /criterion-ref

Add a code reference to a specific testing criterion. Links test implementations to their corresponding testing criteria.

## Usage

```bash
# Add reference to testing criterion by index (1-based)
vtb criterion-ref <task-id> <criterion-index> <file-spec>

# With optional name and description
vtb criterion-ref <task-id> 1 "tests/auth_test.rs:L42-60" \
  --name "test_login_success" \
  --desc "Tests successful login flow"

# Emit a machine-readable operation result
vtb criterion-ref <task-id> 1 "tests/auth_test.rs:L42" --json
```

## Arguments

| Argument | Description |
|----------|-------------|
| `task-id` | Task ID containing the testing criterion; accepts full UUIDs or resolvable 8-character short IDs |
| `criterion-index` | 1-based index among the task's `testing_criterion` sections in display order |
| `file-spec` | File path with optional `:L<line>` or `:L<start>-<end>` suffix |

## Options

| Flag | Description |
|------|-------------|
| `--name` | Optional label (e.g., test function name) |
| `--description` / `--desc` | Optional description of what the reference points to |
| `--json` | Output a machine-readable operation result instead of human-readable text |

## File Specification

Uses the same file spec syntax as `/ref`: file only, `:L<line>`, or
`:L<start>-<end>`. File paths do not need to exist at command time. Missing
files are accepted and reported as a warning so criteria can be linked before
tests are created.

## Example Workflow

1. Add testing criteria to a task:
   ```bash
   vtb section abc123 testing_criterion "User can log in with valid credentials"
   vtb section abc123 testing_criterion "Invalid password shows error message"
   ```

2. Implement tests and link them:
   ```bash
   vtb criterion-ref abc123 1 "tests/auth_test.rs:L10-25" --name "test_valid_login"
   vtb criterion-ref abc123 2 "tests/auth_test.rs:L27-45" --name "test_invalid_password"
   ```

3. View in task details:
   ```bash
   vtb show abc123
   ```

## When to Use

- Linking test implementations to testing criteria
- Tracking which tests cover which requirements
- Verifying test coverage during review

## Validation Behavior

- `criterion-index` must be `1` or greater.
- If the task has no matching testing criterion at that 1-based index, the command fails with a validation error that reports how many testing criteria the task has.
- Invalid file specs fail before updating the task, such as an empty path, missing line number after `:L`, or a reversed line range.
- The human-readable success output includes the linked location, criterion index, task ID, criterion content, optional `[name]`, and any missing-file warning.
- JSON output wraps the operation as `criterion-ref` / `created` with `task_id`, `criterion_index`, `criterion_content`, `path`, `line_start`, `line_end`, `name`, and `warning`.

## See Also

- `/ref` - Add general code references to tasks
- `/section` - Add testing criteria to tasks
