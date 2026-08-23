/// Fragment for task fields matching TaskResponse.
/// Absinthe uses snake_case for all field names.
pub const TASK_FIELDS: &str = r#"
    fragment TaskFields on Task {
        id
        project_id
        title
        description
        level
        priority
        tags
        workflow_id
        current_step_id
        run_controls {
            runnable
            stoppable
            disabled_reason_code
            disabled_reason
            active_run {
                id
                task_id
                status
                latest_step_execution_id
            }
        }
        rejection_reason
        archived
        worktree
        parent_id
        started_at
        completed_at
        inserted_at
        updated_at
        sections {
            id
            section_type
            content
            section_order
            done
            done_at
            inserted_at
            updated_at
            code_refs {
                id
                path
                line_start
                line_end
                name
                description
            }
        }
        code_refs {
            id
            task_id
            section_id
            path
            line_start
            line_end
            name
            description
            inserted_at
            updated_at
        }
    }
"#;

/// Slim fragment for task summaries in list-ready and relationship displays.
pub const TASK_SUMMARY_FIELDS: &str = r#"
    fragment TaskSummaryFields on Task {
        id
        project_id
        title
        level
        priority
        tags
        workflow_id
        current_step_id
        archived
        parent_id
        completed_at
        run_controls {
            runnable
            stoppable
            disabled_reason_code
            disabled_reason
            active_run {
                id
                task_id
                status
                latest_step_execution_id
            }
        }
    }
"#;

/// Slim fragment for the task list. Keep this separate from TASK_FIELDS so
/// list callers do not load descriptions, relationships, or other detail-only
/// associations.
pub const TASK_LIST_FIELDS: &str = r#"
    fragment TaskListFields on Task {
        id
        project_id
        title
        level
        priority
        tags
        workflow_id
        current_step_id
        archived
        parent_id
        completed_at
        updated_at
        run_controls {
            runnable
            stoppable
            disabled_reason_code
            disabled_reason
            active_run {
                id
                task_id
                status
                latest_step_execution_id
            }
        }
    }
"#;

/// Slim fragment for ready tasks. Keep active run state for RunConsole.
pub const READY_TASK_FIELDS: &str = TASK_SUMMARY_FIELDS;

/// List tasks with optional filters.
/// NOTE: Prepend TASK_LIST_FIELDS when sending.
pub const LIST_TASKS: &str = r#"
    query ListTasks(
        $project_id: Uuid4!,
        $level: String,
        $priority: String,
        $parent_id: Uuid4,
        $status: String,
        $step_id: Uuid4,
        $tags: [String!],
        $search: String,
        $workflow_id: Uuid4,
        $root_only: Boolean,
        $blocked: Boolean,
        $includeArchived: Boolean
    ) {
        tasks(
            project_id: $project_id,
            level: $level,
            priority: $priority,
            parent_id: $parent_id,
            status: $status,
            step_id: $step_id,
            tags: $tags,
            search: $search,
            workflow_id: $workflow_id,
            root_only: $root_only,
            blocked: $blocked,
            includeArchived: $includeArchived
        ) {
            ...TaskListFields
        }
    }
"#;

/// Get a single task by ID with nested blockers, dependents, and children.
/// NOTE: Prepend TASK_FIELDS when sending.
pub const GET_TASK: &str = r#"
    query GetTask($id: Uuid4!) {
        task(id: $id) {
            ...TaskFields
            blockers { ...TaskFields }
            dependents { ...TaskFields }
            children { ...TaskFields }
        }
    }
"#;

/// Resolve a short ID prefix to a full task.
/// Only the `id` is needed by callers, so we deliberately skip TASK_FIELDS
/// to avoid loading sections, code_refs, and other heavy associations.
pub const RESOLVE_SHORT_ID: &str = r#"
    query ResolveShortId($project_id: Uuid4!, $prefix: String!) {
        resolveShortId(project_id: $project_id, prefix: $prefix) {
            id
        }
    }
"#;

/// List tasks that are ready (unblocked).
/// NOTE: Prepend TASK_SUMMARY_FIELDS when sending.
pub const READY_TASKS: &str = r#"
    query ReadyTasks($project_id: Uuid4!) {
        list_ready(project_id: $project_id) {
            ...TaskSummaryFields
        }
    }
"#;

/// Get task summary fields by ID.
/// NOTE: Prepend TASK_SUMMARY_FIELDS when sending.
pub const GET_TASK_SUMMARY: &str = r#"
    query GetTaskSummary($id: Uuid4!) {
        task(id: $id) {
            ...TaskSummaryFields
        }
    }
"#;

/// Get only a task title by ID.
pub const GET_TASK_TITLE: &str = r#"
    query GetTaskTitle($id: Uuid4!) {
        task(id: $id) {
            id
            title
        }
    }
"#;

/// Fetch the optional relationship roots needed by `vtb show`.
/// NOTE: Prepend TASK_SUMMARY_FIELDS, WORKFLOW_FIELDS, and TASK_RUN_FIELDS.
pub const SHOW_TASK_RELATED: &str = r#"
    query ShowTaskRelated(
        $project_id: Uuid4!,
        $task_id: Uuid4!,
        $parent_id: Uuid4!,
        $include_parent: Boolean!,
        $workflow_id: Uuid4!,
        $include_workflow: Boolean!
    ) {
        parent: task(id: $parent_id) @include(if: $include_parent) {
            ...TaskSummaryFields
        }
        workflow(id: $workflow_id) @include(if: $include_workflow) {
            ...WorkflowFields
        }
        task_runs(task_id: $task_id) {
            ...TaskRunFields
        }
        workflows(project_id: $project_id) {
            ...WorkflowFields
        }
    }
"#;

/// Find dependency path between two tasks.
/// Returns a flat list of task IDs.
pub const FIND_PATH: &str = r#"
    query FindPath($from_id: Uuid4!, $to_id: Uuid4!) {
        find_path(from_id: $from_id, to_id: $to_id)
    }
"#;

pub const CREATE_TASK: &str = r#"
    mutation CreateTask(
        $project_id: Uuid4!,
        $title: String!,
        $description: String,
        $level: String,
        $priority: String,
        $tags: [String!],
        $parent_id: Uuid4,
        $workflow_id: Uuid4,
        $worktree: String,
        $sections: [TaskSectionCreateInput!]
    ) {
        create_task(
            project_id: $project_id,
            title: $title,
            description: $description,
            level: $level,
            priority: $priority,
            tags: $tags,
            parent_id: $parent_id,
            workflow_id: $workflow_id,
            worktree: $worktree,
            sections: $sections
        ) {
            id
        }
    }
"#;

pub const UPDATE_TASK: &str = r#"
    mutation UpdateTask(
        $id: Uuid4!,
        $title: String,
        $description: String,
        $level: String,
        $priority: String,
        $tags: [String!],
        $parent_id: Uuid4,
        $depends_on_ids: [Uuid4!],
        $archived: Boolean,
        $worktree: String
    ) {
        update_task(
            id: $id,
            title: $title,
            description: $description,
            level: $level,
            priority: $priority,
            tags: $tags,
            parent_id: $parent_id,
            depends_on_ids: $depends_on_ids,
            archived: $archived,
            worktree: $worktree
        ) {
            id
        }
    }
"#;

pub const DELETE_TASK: &str = r#"
    mutation DeleteTask($id: Uuid4!, $cascade: Boolean) {
        delete_task(id: $id, cascade: $cascade) {
            id
        }
    }
"#;

// -- Dependencies --

pub const CREATE_DEPENDENCY: &str = r#"
    mutation CreateTaskDependency($task_id: Uuid4!, $depends_on_id: Uuid4!) {
        create_task_dependency(task_id: $task_id, depends_on_id: $depends_on_id) {
            id
        }
    }
"#;

pub const DELETE_DEPENDENCY: &str = r#"
    mutation DeleteTaskDependency($task_id: Uuid4!, $depends_on_id: Uuid4!) {
        delete_task_dependency(task_id: $task_id, depends_on_id: $depends_on_id) {
            id
        }
    }
"#;

pub const SYNC_TASK_DEPENDENCIES: &str = r#"
    mutation SyncTaskDependencies($task_id: Uuid4!, $depends_on_ids: [Uuid4]!) {
        sync_task_dependencies(task_id: $task_id, depends_on_ids: $depends_on_ids) {
            id
        }
    }
"#;

// -- Workflow Assignment --

pub const ASSIGN_WORKFLOW: &str = r#"
    mutation AssignWorkflow($task_id: Uuid4!, $workflow_id: Uuid4!) {
        assign_workflow(task_id: $task_id, workflow_id: $workflow_id) {
            id workflow_id current_step_id
        }
    }
"#;

pub const UNASSIGN_WORKFLOW: &str = r#"
    mutation UnassignWorkflow($task_id: Uuid4!) {
        unassign_workflow(task_id: $task_id) {
            id
        }
    }
"#;

pub const MOVE_TO_STEP: &str = r#"
    mutation MoveToStep($task_id: Uuid4!, $step_id: Uuid4!) {
        move_to_step(task_id: $task_id, step_id: $step_id) {
            id current_step_id
        }
    }
"#;

pub const ADVANCE_TO_STEP: &str = r#"
    mutation AdvanceToStep($task_id: Uuid4!, $step_id: Uuid4!) {
        advance_to_step(task_id: $task_id, step_id: $step_id) {
            id current_step_id
        }
    }
"#;

// -- Sections --

pub const CREATE_SECTION: &str = r#"
    mutation CreateSection(
        $task_id: Uuid4!,
        $section_type: String!,
        $content: String!,
        $section_order: Int,
        $done: Boolean
    ) {
        create_section(
            task_id: $task_id,
            section_type: $section_type,
            content: $content,
            section_order: $section_order,
            done: $done
        ) {
            id
            section_type
            content
            section_order
            done
            done_at
            code_refs {
                id
                path
                line_start
                line_end
                name
                description
            }
        }
    }
"#;

pub const UPSERT_SECTION: &str = r#"
    mutation UpsertSection(
        $task_id: Uuid4!,
        $section_type: String!,
        $content: String!,
        $section_order: Int,
        $done: Boolean
    ) {
        upsert_section(
            task_id: $task_id,
            section_type: $section_type,
            content: $content,
            section_order: $section_order,
            done: $done
        ) {
            id
            section_type
            content
            section_order
            done
            done_at
            code_refs {
                id
                path
                line_start
                line_end
                name
                description
            }
        }
    }
"#;

pub const UPDATE_SECTION: &str = r#"
    mutation UpdateSection(
        $id: Uuid4!,
        $content: String,
        $done: Boolean,
        $done_at: Datetime
    ) {
        update_section(
            id: $id,
            content: $content,
            done: $done,
            done_at: $done_at
        ) {
            id
            section_type
            content
            section_order
            done
            done_at
            code_refs {
                id
                path
                line_start
                line_end
                name
                description
            }
        }
    }
"#;

pub const DELETE_SECTION: &str = r#"
    mutation DeleteSection($id: Uuid4!) {
        delete_section(id: $id) {
            id
        }
    }
"#;

// -- Code Refs --

pub const CREATE_CODE_REF: &str = r#"
    mutation CreateCodeRef(
        $task_id: Uuid4,
        $section_id: Uuid4,
        $path: String!,
        $line_start: Int,
        $line_end: Int,
        $name: String,
        $description: String
    ) {
        create_code_ref(
            task_id: $task_id,
            section_id: $section_id,
            path: $path,
            line_start: $line_start,
            line_end: $line_end,
            name: $name,
            description: $description
        ) {
            id
        }
    }
"#;

pub const DELETE_CODE_REF: &str = r#"
    mutation DeleteCodeRef($id: Uuid4!) {
        delete_code_ref(id: $id) {
            id
        }
    }
"#;

pub const DELETE_TASK_CODE_REFS: &str = r#"
    mutation DeleteTaskCodeRefs($task_id: Uuid4!) {
        deleteTaskCodeRefs(task_id: $task_id) {
            id
        }
    }
"#;

pub const SET_CODE_REFS: &str = r#"
    mutation SetCodeRefs($task_id: Uuid4!, $refs: [CodeRefInput!]!) {
        set_code_refs(task_id: $task_id, refs: $refs) {
            id
            task_id
            section_id
            path
            line_start
            line_end
            name
            description
            order_index
        }
    }
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn compact_graphql(query: &str) -> String {
        query.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn task_fields_do_not_request_unused_short_id() {
        assert!(!TASK_FIELDS.contains("short_id"));
    }

    #[test]
    fn task_list_fields_include_list_contract_without_detail_associations() {
        let query = compact_graphql(TASK_LIST_FIELDS);

        for field in [
            "id",
            "project_id",
            "title",
            "level",
            "priority",
            "tags",
            "workflow_id",
            "current_step_id",
            "archived",
            "parent_id",
            "completed_at",
            "updated_at",
            "runnable",
            "stoppable",
            "disabled_reason_code",
            "active_run",
        ] {
            assert!(query.contains(field), "list fragment is missing {field}");
        }

        for detail_field in [
            "description",
            "sections",
            "code_refs",
            "worktree",
            "rejection_reason",
            "started_at",
            "inserted_at",
        ] {
            assert!(
                !query.contains(detail_field),
                "list fragment unexpectedly requests {detail_field}"
            );
        }
    }

    #[test]
    fn list_tasks_uses_only_the_slim_fragment() {
        let query = compact_graphql(LIST_TASKS);

        assert!(query.contains("...TaskListFields"));
        assert!(!query.contains("...TaskFields"));
    }

    #[test]
    fn full_task_fragment_remains_detail_complete() {
        for field in ["description", "sections", "code_refs", "worktree"] {
            assert!(TASK_FIELDS.contains(field), "full fragment lost {field}");
        }
    }

    #[test]
    fn resolve_short_id_keeps_dedicated_id_only_query() {
        let query = compact_graphql(RESOLVE_SHORT_ID);

        assert!(query.contains("resolveShortId(project_id: $project_id, prefix: $prefix) { id }"));
        assert!(!RESOLVE_SHORT_ID.contains("...TaskFields"));
        assert!(!RESOLVE_SHORT_ID.contains("short_id"));
    }

    #[test]
    fn create_task_uses_create_section_input_type() {
        let query = compact_graphql(CREATE_TASK);

        assert!(query.contains("$sections: [TaskSectionCreateInput!]"));
    }

    #[test]
    fn create_task_includes_worktree_input() {
        let query = compact_graphql(CREATE_TASK);

        assert!(query.contains("$worktree: String"));
        assert!(query.contains("worktree: $worktree"));
    }

    #[test]
    fn sync_dependencies_matches_backend_list_type() {
        let query = compact_graphql(SYNC_TASK_DEPENDENCIES);

        assert!(query.contains("$depends_on_ids: [Uuid4]!"));
    }

    #[test]
    fn update_task_omits_dead_section_inputs() {
        assert!(!UPDATE_TASK.contains("$sections"));
        assert!(!UPDATE_TASK.contains("section_deletions"));
    }

    #[test]
    fn section_mutations_return_section_code_refs() {
        for query in [CREATE_SECTION, UPSERT_SECTION, UPDATE_SECTION] {
            let query = compact_graphql(query);

            assert!(query.contains("code_refs { id path line_start line_end name description }"));
        }
    }
}
