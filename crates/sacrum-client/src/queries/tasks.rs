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
        $project_id: ID!,
        $level: String,
        $parent_id: ID,
        $status: String,
        $tags: [String!],
        $search: String,
        $workflow_id: ID,
        $root_only: Boolean,
        $blocked: Boolean
    ) {
        tasks(
            project_id: $project_id,
            level: $level,
            parent_id: $parent_id,
            status: $status,
            tags: $tags,
            search: $search,
            workflow_id: $workflow_id,
            root_only: $root_only,
            blocked: $blocked
        ) {
            ...TaskFields
        }
    }
"#;

/// Get a single task by ID with nested blockers, dependents, and children.
/// NOTE: Prepend TASK_FIELDS when sending.
pub const GET_TASK: &str = r#"
    query GetTask($id: ID!) {
        task(id: $id) {
            ...TaskFields
            blockers { ...TaskFields }
            dependents { ...TaskFields }
            children { ...TaskFields }
        }
    }
"#;

/// List tasks that are ready (unblocked).
/// NOTE: Prepend TASK_FIELDS when sending.
pub const READY_TASKS: &str = r#"
    query ReadyTasks($project_id: ID!) {
        list_ready(project_id: $project_id) {
            ...TaskFields
        }
    }
"#;

/// Find dependency path between two tasks.
/// Returns a flat list of task IDs.
pub const FIND_PATH: &str = r#"
    query FindPath($from_id: ID!, $to_id: ID!) {
        find_path(from_id: $from_id, to_id: $to_id)
    }
"#;

pub const CREATE_TASK: &str = r#"
    mutation CreateTask(
        $project_id: ID!,
        $title: String!,
        $description: String,
        $level: String,
        $priority: String,
        $tags: [String!],
        $parent_id: ID,
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
        $id: ID!,
        $title: String,
        $description: String,
        $level: String,
        $priority: String,
        $tags: [String!],
        $needs_human_review: Boolean,
        $revision_feedback: String,
        $parent_id: ID,
        $depends_on_ids: [ID!]
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
            depends_on_ids: $depends_on_ids
        ) {
            id
        }
    }
"#;

pub const DELETE_TASK: &str = r#"
    mutation DeleteTask($id: ID!, $cascade: Boolean) {
        delete_task(id: $id, cascade: $cascade) {
            id
        }
    }
"#;

// -- Dependencies --

pub const CREATE_DEPENDENCY: &str = r#"
    mutation CreateTaskDependency($task_id: ID!, $depends_on_id: ID!) {
        create_task_dependency(task_id: $task_id, depends_on_id: $depends_on_id) {
            id
        }
    }
"#;

pub const DELETE_DEPENDENCY: &str = r#"
    mutation DeleteTaskDependency($task_id: ID!, $depends_on_id: ID!) {
        delete_task_dependency(task_id: $task_id, depends_on_id: $depends_on_id) {
            id
        }
    }
"#;

// -- Workflow Assignment --

pub const ASSIGN_WORKFLOW: &str = r#"
    mutation AssignWorkflow($task_id: ID!, $workflow_id: ID!) {
        assign_workflow(task_id: $task_id, workflow_id: $workflow_id) {
            id workflow_id current_step_id
        }
    }
"#;

pub const UNASSIGN_WORKFLOW: &str = r#"
    mutation UnassignWorkflow($task_id: ID!) {
        unassign_workflow(task_id: $task_id) {
            id
        }
    }
"#;

pub const MOVE_TO_STEP: &str = r#"
    mutation MoveToStep($task_id: ID!, $step_id: ID!) {
        move_to_step(task_id: $task_id, step_id: $step_id) {
            id current_step_id
        }
    }
"#;

// -- Sections --

pub const CREATE_SECTION: &str = r#"
    mutation CreateSection(
        $task_id: ID!,
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
        $id: ID!,
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
    mutation DeleteSection($id: ID!) {
        delete_section(id: $id) {
            id
        }
    }
"#;

// -- Code Refs --

pub const CREATE_CODE_REF: &str = r#"
    mutation CreateCodeRef(
        $task_id: ID,
        $section_id: ID,
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
    mutation DeleteCodeRef($id: ID!) {
        delete_code_ref(id: $id) {
            id
        }
    }
"#;
