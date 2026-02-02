# Vertebrae CLI Integration Tests

This directory contains the integration test framework for the Vertebrae CLI, designed to test CLI command execution against service layer abstractions.

## Overview

The integration tests verify that CLI commands work correctly with the service layer, covering:

- **Lifecycle Management**: Task creation, updates, deletion, and status transitions
- **Querying**: Listing tasks, filtering, showing details, tree display
- **Relationships**: Parent-child hierarchies, task dependencies, path finding
- **Sections**: Implementation steps, constraints, testing criteria, code references
- **Workflows**: Workflow creation, assignment, step navigation
- **Error Handling**: Input validation, not-found errors, constraint violations

## Architecture

### Service Abstraction Layer

The CLI commands are designed to work with trait-based service abstractions:

- **TaskService**: Task CRUD, relationships, sections, code refs
- **WorkflowService**: Workflow management, task assignments, step transitions
- **ExecutionService**: Step execution tracking, session logs
- **StepService**: Workflow step management

This trait-based architecture enables testability through mock implementations.

### Test Structure

Tests are organized into logical modules within `basic_tests.rs`:

```
integration_tests/
├── mod.rs                 # Test module declarations
├── mock.rs               # Mock service implementations (placeholder)
├── basic_tests.rs        # Main test suite with documented test cases
└── README.md            # This file
```

## Running Tests

### Run all integration tests

```bash
cargo test --test integration_tests
```

### Run specific test module

```bash
# Lifecycle tests only
cargo test --test integration_tests lifecycle_tests::

# Relationship tests only
cargo test --test integration_tests relationship_tests::
```

### Run with detailed output

```bash
cargo test --test integration_tests -- --nocapture --test-threads=1
```

### Run with backtrace

```bash
RUST_BACKTRACE=1 cargo test --test integration_tests
```

## Test Organization

### lifecycle_tests

Tests for task creation, updates, deletion, and lifecycle operations:

- `test_create_basic_task`: Basic task creation with minimum fields
- `test_create_task_with_metadata`: Full task metadata (level, priority, tags, description)
- `test_update_task`: Updating existing task fields
- `test_delete_task`: Task deletion
- `test_delete_task_cascade`: Cascading deletion of child tasks

### query_tests

Tests for listing, filtering, and retrieving task information:

- `test_list_all_tasks`: List all tasks in the system
- `test_list_ready_tasks`: List tasks without blockers (ready for work)
- `test_show_task_details`: Display complete task information

### relationship_tests

Tests for task hierarchies and dependencies:

- `test_set_parent_relationship`: Create parent-child relationships
- `test_add_task_dependency`: Create task dependencies (blockers)
- `test_remove_dependency`: Remove dependency relationships
- `test_find_dependency_path`: Find shortest path through dependencies
- `test_get_blockers`: List all blocking tasks for a task

### section_tests

Tests for task metadata sections and code references:

- `test_add_step_section`: Add implementation steps to tasks
- `test_add_constraint_section`: Add constraints (e.g., "must handle errors")
- `test_add_code_reference`: Link task to source code locations
- `test_edit_section`: Modify section content
- `test_mark_step_done`: Mark implementation steps as complete
- `test_remove_section`: Remove sections and renumber

### workflow_tests

Tests for workflow management and task workflow assignment:

- `test_create_workflow`: Create workflows with named steps
- `test_assign_workflow_to_task`: Assign workflow to task
- `test_advance_workflow_step`: Move task to next workflow step
- `test_retreat_workflow_step`: Move task back to previous step
- `test_unassign_workflow`: Remove workflow assignment

### error_tests

Tests for error handling and input validation:

- `test_empty_title_validation`: Reject tasks with empty titles
- `test_nonexistent_task_operations`: Handle operations on non-existent tasks
- `test_circular_dependency_detection`: Prevent circular dependencies
- `test_invalid_parent_relationship`: Validate parent task exists
- `test_missing_workflow_assignment`: Validate workflow exists

## Implementing Tests

Each test should follow the BDD (Behavior-Driven Development) pattern:

```rust
#[tokio::test]
async fn test_example() {
    // Given: Set up initial state
    // (Create test services, configure initial data)

    // When: Execute the action under test
    // (Call CLI command or service method)

    // Then: Verify the expected outcome
    // assert!(result.is_ok());
    // assert_eq!(actual, expected);
}
```

## Mock Services

The test framework uses mock service implementations to avoid needing a live backend during testing. The mocks are located in `mock.rs` and should implement:

- **MockTaskService**: In-memory task storage with relationship tracking
- **MockWorkflowService**: Workflow creation and management
- **MockExecutionService**: Execution tracking
- **MockStepService**: Step management

## Coverage Requirements

All integration tests should include assertions that validate:

1. **Success cases**: Operations complete successfully with expected output
2. **Error cases**: Invalid inputs are properly rejected
3. **State verification**: System state is correctly updated after operations
4. **Consistency**: Related data remains consistent (e.g., parent-child relationships)

The project aims for >= 85% code coverage.

## Adding New Tests

To add a new integration test:

1. **Identify test area**: Which module does it belong to (lifecycle, query, etc.)?
2. **Follow BDD pattern**: Given-When-Then comments
3. **Use descriptive name**: Test name should indicate what is being tested
4. **Add to appropriate module**: Include in correct test module in `basic_tests.rs`
5. **Document assumptions**: Add comments about preconditions
6. **Verify assertions**: Each test should have at least one assertion

## Future Work

To fully implement integration tests with real backend mocking:

1. **Implement MockTaskService**: In-memory task storage with Arc<Mutex<HashMap>>
2. **Implement MockWorkflowService**: Workflow management mocks
3. **Implement MockExecutionService**: Execution tracking mocks
4. **Implement MockStepService**: Step management mocks
5. **Add realistic test data**: Seeds for task hierarchies and workflows
6. **Complete test implementations**: Fill in test bodies with actual assertions

## Related Documentation

- [CLI Architecture](../../src/lib.rs) - Command structure and trait dependencies
- [Service Layer](../../../core/src/service.rs) - TaskService trait definition
- [Workflow Service](../../../core/src/workflow_service.rs) - WorkflowService trait definition
- [Project Guidelines](../../../CLAUDE.md) - Development standards
