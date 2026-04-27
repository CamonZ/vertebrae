/// Fragment for task fields matching TaskResponse.
/// Absinthe uses snake_case for all field names.
pub const TASK_FIELDS: &str = r#"
    fragment TaskFields on Task {
        id
        short_id
        project_id
        title
        description
        level
        priority
        tags
        workflow_id
        current_step_id
        needs_human_review
        review_comment
        rejection_reason
        revision_feedback
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

/// List tasks with optional filters.
/// NOTE: Prepend TASK_FIELDS when sending.
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
            ...TaskFields
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
/// NOTE: Prepend TASK_FIELDS when sending.
pub const READY_TASKS: &str = r#"
    query ReadyTasks($project_id: Uuid4!) {
        list_ready(project_id: $project_id) {
            ...TaskFields
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
        $sections: [TaskSectionInput!]
    ) {
        create_task(
            project_id: $project_id,
            title: $title,
            description: $description,
            level: $level,
            priority: $priority,
            tags: $tags,
            parent_id: $parent_id,
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
        $needs_human_review: Boolean,
        $revision_feedback: String,
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
            needs_human_review: $needs_human_review,
            revision_feedback: $revision_feedback,
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

pub const START_STEP: &str = r#"
    mutation StartStep($task_id: Uuid4!) {
        start_step(task_id: $task_id) {
            id current_step_id
        }
    }
"#;

pub const COMPLETE_STEP: &str = r#"
    mutation CompleteStep($task_id: Uuid4!) {
        complete_step(task_id: $task_id) {
            id current_step_id
        }
    }
"#;

pub const REJECT_STEP: &str = r#"
    mutation RejectStep($task_id: Uuid4!, $target_step_id: Uuid4!, $feedback: String) {
        reject_step(task_id: $task_id, target_step_id: $target_step_id, feedback: $feedback) {
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
            id done done_at
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
