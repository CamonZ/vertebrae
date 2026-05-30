# Code References

Link tasks to specific code locations:

```bash
# File reference
vtb ref <id> "src/service.rs"

# Specific line
vtb ref <id> "src/service.rs:L42"

# Line range with name
vtb ref <id> "src/service.rs:L42-60" --name "process_request" --desc "Main dispatch"

# Link test to testing criterion (1-based criterion index)
vtb criterion-ref <id> 1 "tests/service_test.rs:L10-25" \
  --name "test_process_request"
vtb criterion-ref <id> 1 "tests/service_test.rs:L10-25" \
  --description "Covers request processing"
vtb criterion-ref <id> 1 "tests/service_test.rs:L10-25" --json

# View and remove references
vtb refs <id>
vtb unref <id> "src/service.rs"
vtb unref <id> --all
```

For `vtb criterion-ref`, the criterion index is 1-based among the task's
`testing_criterion` sections. File specs use the same syntax as `vtb ref`;
reversed ranges, empty paths, and missing line numbers after `:L` are validation
errors. `--description` also has the visible alias `--desc`. Missing files are
accepted with a warning so tests can be linked before the file is created. With
`--json`, the command returns an operation envelope with `command`
(`criterion-ref`), `status` (`created`), `task_id`, `criterion_index`,
`criterion_content`, `path`, `line_start`, `line_end`, `name`, and `warning`.

---
