//! Data models for Vertebrae task management
//!
//! Defines Rust types that map to the SurrealDB schema for tasks,
//! sections, code references, and related enums.

// Allow dead code for types that are defined for future use
#![allow(dead_code)]

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use surrealdb::sql::Thing;

/// Task hierarchy level
///
/// Represents the granularity of a task in the hierarchy:
/// Epic > Ticket > Task
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Epic,
    Ticket,
    Task,
}

impl Level {
    /// Returns the string representation used in the database
    pub fn as_str(&self) -> &'static str {
        match self {
            Level::Epic => "epic",
            Level::Ticket => "ticket",
            Level::Task => "task",
        }
    }
}

impl std::fmt::Display for Level {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Task status
///
/// Represents the current state of a task in its lifecycle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Todo,
    InProgress,
    Done,
    Blocked,
}

impl Status {
    /// Returns the string representation used in the database
    pub fn as_str(&self) -> &'static str {
        match self {
            Status::Todo => "todo",
            Status::InProgress => "in_progress",
            Status::Done => "done",
            Status::Blocked => "blocked",
        }
    }
}

impl std::fmt::Display for Status {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Task priority level
///
/// Optional priority for tasks, from low to critical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    Low,
    Medium,
    High,
    Critical,
}

impl Priority {
    /// Returns the string representation used in the database
    pub fn as_str(&self) -> &'static str {
        match self {
            Priority::Low => "low",
            Priority::Medium => "medium",
            Priority::High => "high",
            Priority::Critical => "critical",
        }
    }
}

impl std::fmt::Display for Priority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Section type for task documentation
///
/// Defines the different types of content sections that can be
/// embedded in a task document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SectionType {
    Goal,
    Context,
    CurrentBehavior,
    DesiredBehavior,
    Step,
    TestingCriterion,
    AntiPattern,
    FailureTest,
    Constraint,
}

impl SectionType {
    /// Returns the string representation used in the database
    pub fn as_str(&self) -> &'static str {
        match self {
            SectionType::Goal => "goal",
            SectionType::Context => "context",
            SectionType::CurrentBehavior => "current_behavior",
            SectionType::DesiredBehavior => "desired_behavior",
            SectionType::Step => "step",
            SectionType::TestingCriterion => "testing_criterion",
            SectionType::AntiPattern => "anti_pattern",
            SectionType::FailureTest => "failure_test",
            SectionType::Constraint => "constraint",
        }
    }
}

impl std::fmt::Display for SectionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// A section of content within a task
///
/// Sections provide structured documentation for tasks,
/// organized by type (goal, context, steps, etc.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Section {
    /// The type of this section
    #[serde(rename = "type")]
    pub section_type: SectionType,

    /// The content of this section
    pub content: String,

    /// Optional ordering for sections of the same type
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,

    /// Whether this section (typically a step) is done
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
}

impl Section {
    /// Create a new section with the given type and content
    pub fn new(section_type: SectionType, content: impl Into<String>) -> Self {
        Self {
            section_type,
            content: content.into(),
            order: None,
            done: None,
        }
    }

    /// Create a new section with ordering
    pub fn with_order(section_type: SectionType, content: impl Into<String>, order: u32) -> Self {
        Self {
            section_type,
            content: content.into(),
            order: Some(order),
            done: None,
        }
    }

    /// Mark this section as done
    pub fn with_done(mut self, done: bool) -> Self {
        self.done = Some(done);
        self
    }
}

/// A code reference attached to a task
///
/// References link tasks to specific locations in the codebase,
/// enabling traceability between documentation and implementation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeRef {
    /// Path to the file (relative to repository root)
    pub path: String,

    /// Optional starting line number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_start: Option<u32>,

    /// Optional ending line number
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_end: Option<u32>,

    /// Optional name/label for this reference (e.g., function name)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// Optional description of what this reference points to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl CodeRef {
    /// Create a new code reference to a file
    pub fn file(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            line_start: None,
            line_end: None,
            name: None,
            description: None,
        }
    }

    /// Create a new code reference to a specific line
    pub fn line(path: impl Into<String>, line: u32) -> Self {
        Self {
            path: path.into(),
            line_start: Some(line),
            line_end: None,
            name: None,
            description: None,
        }
    }

    /// Create a new code reference to a line range
    pub fn range(path: impl Into<String>, start: u32, end: u32) -> Self {
        Self {
            path: path.into(),
            line_start: Some(start),
            line_end: Some(end),
            name: None,
            description: None,
        }
    }

    /// Add a name/label to this code reference
    pub fn with_name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Add a description to this code reference
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }
}

/// A task in the Vertebrae task management system
///
/// Tasks are the primary nodes in the graph, with relationships
/// defined by `child_of` and `depends_on` edges.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    /// Unique identifier (SurrealDB record ID)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<Thing>,

    /// Task title
    pub title: String,

    /// Hierarchy level (epic, ticket, task)
    pub level: Level,

    /// Current status
    pub status: Status,

    /// Optional priority
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<Priority>,

    /// Tags for categorization
    #[serde(default)]
    pub tags: Vec<String>,

    /// Creation timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,

    /// Last update timestamp
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,

    /// When this task was started (transitioned to in_progress)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,

    /// When this task was completed (transitioned to done)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,

    /// Embedded sections
    #[serde(default)]
    pub sections: Vec<Section>,

    /// Embedded code references
    #[serde(default, rename = "refs")]
    pub code_refs: Vec<CodeRef>,
}

impl Task {
    /// Create a new task with required fields
    pub fn new(title: impl Into<String>, level: Level) -> Self {
        Self {
            id: None,
            title: title.into(),
            level,
            status: Status::Todo,
            priority: None,
            tags: Vec::new(),
            created_at: None,
            updated_at: None,
            started_at: None,
            completed_at: None,
            sections: Vec::new(),
            code_refs: Vec::new(),
        }
    }

    /// Set the status of this task
    pub fn with_status(mut self, status: Status) -> Self {
        self.status = status;
        self
    }

    /// Set the priority of this task
    pub fn with_priority(mut self, priority: Priority) -> Self {
        self.priority = Some(priority);
        self
    }

    /// Add a tag to this task
    pub fn with_tag(mut self, tag: impl Into<String>) -> Self {
        self.tags.push(tag.into());
        self
    }

    /// Add multiple tags to this task
    pub fn with_tags(mut self, tags: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.tags.extend(tags.into_iter().map(|t| t.into()));
        self
    }

    /// Add a section to this task
    pub fn with_section(mut self, section: Section) -> Self {
        self.sections.push(section);
        self
    }

    /// Add a code reference to this task
    pub fn with_code_ref(mut self, code_ref: CodeRef) -> Self {
        self.code_refs.push(code_ref);
        self
    }
}

impl PartialEq for Task {
    fn eq(&self, other: &Self) -> bool {
        self.title == other.title
            && self.level == other.level
            && self.status == other.status
            && self.priority == other.priority
            && self.tags == other.tags
            && self.sections == other.sections
            && self.code_refs == other.code_refs
    }
}

impl Eq for Task {}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    // Level enum tests
    #[test]
    fn test_level_as_str() {
        assert_eq!(Level::Epic.as_str(), "epic");
        assert_eq!(Level::Ticket.as_str(), "ticket");
        assert_eq!(Level::Task.as_str(), "task");
    }

    #[test]
    fn test_level_display() {
        assert_eq!(format!("{}", Level::Epic), "epic");
        assert_eq!(format!("{}", Level::Ticket), "ticket");
        assert_eq!(format!("{}", Level::Task), "task");
    }

    #[test]
    fn test_level_serialize() {
        assert_eq!(serde_json::to_string(&Level::Epic).unwrap(), "\"epic\"");
        assert_eq!(serde_json::to_string(&Level::Ticket).unwrap(), "\"ticket\"");
        assert_eq!(serde_json::to_string(&Level::Task).unwrap(), "\"task\"");
    }

    #[test]
    fn test_level_deserialize() {
        assert_eq!(
            serde_json::from_str::<Level>("\"epic\"").unwrap(),
            Level::Epic
        );
        assert_eq!(
            serde_json::from_str::<Level>("\"ticket\"").unwrap(),
            Level::Ticket
        );
        assert_eq!(
            serde_json::from_str::<Level>("\"task\"").unwrap(),
            Level::Task
        );
    }

    #[test]
    fn test_level_clone_and_eq() {
        let level = Level::Epic;
        let cloned = level.clone();
        assert_eq!(level, cloned);
    }

    // Status enum tests
    #[test]
    fn test_status_as_str() {
        assert_eq!(Status::Todo.as_str(), "todo");
        assert_eq!(Status::InProgress.as_str(), "in_progress");
        assert_eq!(Status::Done.as_str(), "done");
        assert_eq!(Status::Blocked.as_str(), "blocked");
    }

    #[test]
    fn test_status_display() {
        assert_eq!(format!("{}", Status::Todo), "todo");
        assert_eq!(format!("{}", Status::InProgress), "in_progress");
        assert_eq!(format!("{}", Status::Done), "done");
        assert_eq!(format!("{}", Status::Blocked), "blocked");
    }

    #[test]
    fn test_status_serialize() {
        assert_eq!(serde_json::to_string(&Status::Todo).unwrap(), "\"todo\"");
        assert_eq!(
            serde_json::to_string(&Status::InProgress).unwrap(),
            "\"in_progress\""
        );
        assert_eq!(serde_json::to_string(&Status::Done).unwrap(), "\"done\"");
        assert_eq!(
            serde_json::to_string(&Status::Blocked).unwrap(),
            "\"blocked\""
        );
    }

    #[test]
    fn test_status_deserialize() {
        assert_eq!(
            serde_json::from_str::<Status>("\"todo\"").unwrap(),
            Status::Todo
        );
        assert_eq!(
            serde_json::from_str::<Status>("\"in_progress\"").unwrap(),
            Status::InProgress
        );
        assert_eq!(
            serde_json::from_str::<Status>("\"done\"").unwrap(),
            Status::Done
        );
        assert_eq!(
            serde_json::from_str::<Status>("\"blocked\"").unwrap(),
            Status::Blocked
        );
    }

    #[test]
    fn test_status_clone_and_eq() {
        let status = Status::InProgress;
        let cloned = status.clone();
        assert_eq!(status, cloned);
    }

    // Priority enum tests
    #[test]
    fn test_priority_as_str() {
        assert_eq!(Priority::Low.as_str(), "low");
        assert_eq!(Priority::Medium.as_str(), "medium");
        assert_eq!(Priority::High.as_str(), "high");
        assert_eq!(Priority::Critical.as_str(), "critical");
    }

    #[test]
    fn test_priority_display() {
        assert_eq!(format!("{}", Priority::Low), "low");
        assert_eq!(format!("{}", Priority::Medium), "medium");
        assert_eq!(format!("{}", Priority::High), "high");
        assert_eq!(format!("{}", Priority::Critical), "critical");
    }

    #[test]
    fn test_priority_serialize() {
        assert_eq!(serde_json::to_string(&Priority::Low).unwrap(), "\"low\"");
        assert_eq!(
            serde_json::to_string(&Priority::Medium).unwrap(),
            "\"medium\""
        );
        assert_eq!(serde_json::to_string(&Priority::High).unwrap(), "\"high\"");
        assert_eq!(
            serde_json::to_string(&Priority::Critical).unwrap(),
            "\"critical\""
        );
    }

    #[test]
    fn test_priority_deserialize() {
        assert_eq!(
            serde_json::from_str::<Priority>("\"low\"").unwrap(),
            Priority::Low
        );
        assert_eq!(
            serde_json::from_str::<Priority>("\"medium\"").unwrap(),
            Priority::Medium
        );
        assert_eq!(
            serde_json::from_str::<Priority>("\"high\"").unwrap(),
            Priority::High
        );
        assert_eq!(
            serde_json::from_str::<Priority>("\"critical\"").unwrap(),
            Priority::Critical
        );
    }

    #[test]
    fn test_priority_clone_and_eq() {
        let priority = Priority::High;
        let cloned = priority.clone();
        assert_eq!(priority, cloned);
    }

    // SectionType enum tests
    #[test]
    fn test_section_type_as_str() {
        assert_eq!(SectionType::Goal.as_str(), "goal");
        assert_eq!(SectionType::Context.as_str(), "context");
        assert_eq!(SectionType::CurrentBehavior.as_str(), "current_behavior");
        assert_eq!(SectionType::DesiredBehavior.as_str(), "desired_behavior");
        assert_eq!(SectionType::Step.as_str(), "step");
        assert_eq!(SectionType::TestingCriterion.as_str(), "testing_criterion");
        assert_eq!(SectionType::AntiPattern.as_str(), "anti_pattern");
        assert_eq!(SectionType::FailureTest.as_str(), "failure_test");
        assert_eq!(SectionType::Constraint.as_str(), "constraint");
    }

    #[test]
    fn test_section_type_display() {
        assert_eq!(format!("{}", SectionType::Goal), "goal");
        assert_eq!(format!("{}", SectionType::Context), "context");
        assert_eq!(
            format!("{}", SectionType::CurrentBehavior),
            "current_behavior"
        );
        assert_eq!(
            format!("{}", SectionType::DesiredBehavior),
            "desired_behavior"
        );
        assert_eq!(format!("{}", SectionType::Step), "step");
        assert_eq!(
            format!("{}", SectionType::TestingCriterion),
            "testing_criterion"
        );
        assert_eq!(format!("{}", SectionType::AntiPattern), "anti_pattern");
        assert_eq!(format!("{}", SectionType::FailureTest), "failure_test");
        assert_eq!(format!("{}", SectionType::Constraint), "constraint");
    }

    #[test]
    fn test_section_type_serialize() {
        assert_eq!(
            serde_json::to_string(&SectionType::Goal).unwrap(),
            "\"goal\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::Context).unwrap(),
            "\"context\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::CurrentBehavior).unwrap(),
            "\"current_behavior\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::DesiredBehavior).unwrap(),
            "\"desired_behavior\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::Step).unwrap(),
            "\"step\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::TestingCriterion).unwrap(),
            "\"testing_criterion\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::AntiPattern).unwrap(),
            "\"anti_pattern\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::FailureTest).unwrap(),
            "\"failure_test\""
        );
        assert_eq!(
            serde_json::to_string(&SectionType::Constraint).unwrap(),
            "\"constraint\""
        );
    }

    #[test]
    fn test_section_type_deserialize() {
        assert_eq!(
            serde_json::from_str::<SectionType>("\"goal\"").unwrap(),
            SectionType::Goal
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"context\"").unwrap(),
            SectionType::Context
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"current_behavior\"").unwrap(),
            SectionType::CurrentBehavior
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"desired_behavior\"").unwrap(),
            SectionType::DesiredBehavior
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"step\"").unwrap(),
            SectionType::Step
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"testing_criterion\"").unwrap(),
            SectionType::TestingCriterion
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"anti_pattern\"").unwrap(),
            SectionType::AntiPattern
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"failure_test\"").unwrap(),
            SectionType::FailureTest
        );
        assert_eq!(
            serde_json::from_str::<SectionType>("\"constraint\"").unwrap(),
            SectionType::Constraint
        );
    }

    #[test]
    fn test_section_type_clone_and_eq() {
        let section_type = SectionType::Goal;
        let cloned = section_type.clone();
        assert_eq!(section_type, cloned);
    }

    // Section tests
    #[test]
    fn test_section_new() {
        let section = Section::new(SectionType::Goal, "Implement feature X");
        assert_eq!(section.section_type, SectionType::Goal);
        assert_eq!(section.content, "Implement feature X");
        assert!(section.order.is_none());
    }

    #[test]
    fn test_section_with_order() {
        let section = Section::with_order(SectionType::Step, "Step 1: Do something", 1);
        assert_eq!(section.section_type, SectionType::Step);
        assert_eq!(section.content, "Step 1: Do something");
        assert_eq!(section.order, Some(1));
        assert!(section.done.is_none());
    }

    #[test]
    fn test_section_with_done() {
        let section = Section::with_order(SectionType::Step, "Step 1", 1).with_done(true);
        assert_eq!(section.section_type, SectionType::Step);
        assert_eq!(section.content, "Step 1");
        assert_eq!(section.order, Some(1));
        assert_eq!(section.done, Some(true));
    }

    #[test]
    fn test_section_with_done_false() {
        let section = Section::new(SectionType::Step, "Step 1").with_done(false);
        assert_eq!(section.done, Some(false));
    }

    #[test]
    fn test_section_serialize() {
        let section = Section::new(SectionType::Goal, "Test goal");
        let value = serde_json::to_value(&section).unwrap();
        assert_eq!(value["type"], "goal");
        assert_eq!(value["content"], "Test goal");
    }

    #[test]
    fn test_section_serialize_with_order() {
        let section = Section::with_order(SectionType::Step, "Step content", 5);
        let value = serde_json::to_value(&section).unwrap();
        assert_eq!(value["type"], "step");
        assert_eq!(value["content"], "Step content");
        assert_eq!(value["order"], 5);
    }

    #[test]
    fn test_section_serialize_with_done() {
        let section = Section::with_order(SectionType::Step, "Step content", 1).with_done(true);
        let value = serde_json::to_value(&section).unwrap();
        assert_eq!(value["type"], "step");
        assert_eq!(value["content"], "Step content");
        assert_eq!(value["order"], 1);
        assert_eq!(value["done"], true);
    }

    #[test]
    fn test_section_deserialize_with_done() {
        let json = r#"{"type":"step","content":"Do this","order":1,"done":true}"#;
        let section: Section = serde_json::from_str(json).unwrap();
        assert_eq!(section.section_type, SectionType::Step);
        assert_eq!(section.content, "Do this");
        assert_eq!(section.order, Some(1));
        assert_eq!(section.done, Some(true));
    }

    #[test]
    fn test_section_deserialize() {
        let json = r#"{"type":"context","content":"Some context"}"#;
        let section: Section = serde_json::from_str(json).unwrap();
        assert_eq!(section.section_type, SectionType::Context);
        assert_eq!(section.content, "Some context");
        assert!(section.order.is_none());
    }

    #[test]
    fn test_section_deserialize_with_order() {
        let json = r#"{"type":"step","content":"Do this","order":3}"#;
        let section: Section = serde_json::from_str(json).unwrap();
        assert_eq!(section.section_type, SectionType::Step);
        assert_eq!(section.content, "Do this");
        assert_eq!(section.order, Some(3));
    }

    #[test]
    fn test_section_clone_and_eq() {
        let section = Section::new(SectionType::Goal, "Test");
        let cloned = section.clone();
        assert_eq!(section, cloned);
    }

    // CodeRef tests
    #[test]
    fn test_code_ref_file() {
        let code_ref = CodeRef::file("src/main.rs");
        assert_eq!(code_ref.path, "src/main.rs");
        assert!(code_ref.line_start.is_none());
        assert!(code_ref.line_end.is_none());
        assert!(code_ref.description.is_none());
    }

    #[test]
    fn test_code_ref_line() {
        let code_ref = CodeRef::line("src/lib.rs", 42);
        assert_eq!(code_ref.path, "src/lib.rs");
        assert_eq!(code_ref.line_start, Some(42));
        assert!(code_ref.line_end.is_none());
        assert!(code_ref.description.is_none());
    }

    #[test]
    fn test_code_ref_range() {
        let code_ref = CodeRef::range("src/module.rs", 10, 50);
        assert_eq!(code_ref.path, "src/module.rs");
        assert_eq!(code_ref.line_start, Some(10));
        assert_eq!(code_ref.line_end, Some(50));
        assert!(code_ref.description.is_none());
    }

    #[test]
    fn test_code_ref_with_description() {
        let code_ref = CodeRef::file("src/api.rs").with_description("API implementation");
        assert_eq!(code_ref.path, "src/api.rs");
        assert_eq!(code_ref.description, Some("API implementation".to_string()));
    }

    #[test]
    fn test_code_ref_serialize() {
        let code_ref = CodeRef::range("test.rs", 1, 10);
        let value = serde_json::to_value(&code_ref).unwrap();
        assert_eq!(value["path"], "test.rs");
        assert_eq!(value["line_start"], 1);
        assert_eq!(value["line_end"], 10);
    }

    #[test]
    fn test_code_ref_serialize_minimal() {
        let code_ref = CodeRef::file("minimal.rs");
        let value = serde_json::to_value(&code_ref).unwrap();
        assert_eq!(value["path"], "minimal.rs");
        assert!(value.get("line_start").is_none());
        assert!(value.get("line_end").is_none());
        assert!(value.get("description").is_none());
    }

    #[test]
    fn test_code_ref_deserialize() {
        let json = r#"{"path":"src/test.rs","line_start":5,"line_end":15}"#;
        let code_ref: CodeRef = serde_json::from_str(json).unwrap();
        assert_eq!(code_ref.path, "src/test.rs");
        assert_eq!(code_ref.line_start, Some(5));
        assert_eq!(code_ref.line_end, Some(15));
    }

    #[test]
    fn test_code_ref_deserialize_minimal() {
        let json = r#"{"path":"file.rs"}"#;
        let code_ref: CodeRef = serde_json::from_str(json).unwrap();
        assert_eq!(code_ref.path, "file.rs");
        assert!(code_ref.line_start.is_none());
        assert!(code_ref.line_end.is_none());
        assert!(code_ref.description.is_none());
    }

    #[test]
    fn test_code_ref_clone_and_eq() {
        let code_ref = CodeRef::range("test.rs", 1, 10);
        let cloned = code_ref.clone();
        assert_eq!(code_ref, cloned);
    }

    // Task tests
    #[test]
    fn test_task_new() {
        let task = Task::new("Implement feature", Level::Task);
        assert!(task.id.is_none());
        assert_eq!(task.title, "Implement feature");
        assert_eq!(task.level, Level::Task);
        assert_eq!(task.status, Status::Todo);
        assert!(task.priority.is_none());
        assert!(task.tags.is_empty());
        assert!(task.created_at.is_none());
        assert!(task.updated_at.is_none());
        assert!(task.started_at.is_none());
        assert!(task.completed_at.is_none());
        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
    }

    #[test]
    fn test_task_with_status() {
        let task = Task::new("Test", Level::Task).with_status(Status::InProgress);
        assert_eq!(task.status, Status::InProgress);
    }

    #[test]
    fn test_task_with_priority() {
        let task = Task::new("Test", Level::Task).with_priority(Priority::High);
        assert_eq!(task.priority, Some(Priority::High));
    }

    #[test]
    fn test_task_with_tag() {
        let task = Task::new("Test", Level::Task).with_tag("backend");
        assert_eq!(task.tags, vec!["backend"]);
    }

    #[test]
    fn test_task_with_tags() {
        let task = Task::new("Test", Level::Task).with_tags(["backend", "api", "v2"]);
        assert_eq!(task.tags, vec!["backend", "api", "v2"]);
    }

    #[test]
    fn test_task_with_section() {
        let task =
            Task::new("Test", Level::Task).with_section(Section::new(SectionType::Goal, "Goal"));
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.sections[0].section_type, SectionType::Goal);
    }

    #[test]
    fn test_task_with_code_ref() {
        let task = Task::new("Test", Level::Task).with_code_ref(CodeRef::file("src/main.rs"));
        assert_eq!(task.code_refs.len(), 1);
        assert_eq!(task.code_refs[0].path, "src/main.rs");
    }

    #[test]
    fn test_task_builder_chain() {
        let task = Task::new("Complex Task", Level::Epic)
            .with_status(Status::InProgress)
            .with_priority(Priority::Critical)
            .with_tags(["urgent", "backend"])
            .with_section(Section::new(SectionType::Goal, "Complete the epic"))
            .with_code_ref(CodeRef::file("docs/spec.md"));

        assert_eq!(task.title, "Complex Task");
        assert_eq!(task.level, Level::Epic);
        assert_eq!(task.status, Status::InProgress);
        assert_eq!(task.priority, Some(Priority::Critical));
        assert_eq!(task.tags, vec!["urgent", "backend"]);
        assert_eq!(task.sections.len(), 1);
        assert_eq!(task.code_refs.len(), 1);
    }

    #[test]
    fn test_task_serialize() {
        let task = Task::new("Test Task", Level::Ticket)
            .with_status(Status::Done)
            .with_priority(Priority::Medium)
            .with_tag("test");

        let value = serde_json::to_value(&task).unwrap();
        assert_eq!(value["title"], "Test Task");
        assert_eq!(value["level"], "ticket");
        assert_eq!(value["status"], "done");
        assert_eq!(value["priority"], "medium");
        assert_eq!(value["tags"], serde_json::json!(["test"]));
    }

    #[test]
    fn test_task_serialize_minimal() {
        let task = Task::new("Minimal", Level::Task);
        let value = serde_json::to_value(&task).unwrap();
        assert_eq!(value["title"], "Minimal");
        assert_eq!(value["level"], "task");
        assert_eq!(value["status"], "todo");
        assert!(value.get("priority").is_none());
        assert!(value.get("id").is_none());
    }

    #[test]
    fn test_task_deserialize() {
        let json = r#"{
            "title": "Deserialized Task",
            "level": "epic",
            "status": "blocked",
            "priority": "low",
            "tags": ["a", "b"],
            "sections": [],
            "refs": []
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert_eq!(task.title, "Deserialized Task");
        assert_eq!(task.level, Level::Epic);
        assert_eq!(task.status, Status::Blocked);
        assert_eq!(task.priority, Some(Priority::Low));
        assert_eq!(task.tags, vec!["a", "b"]);
    }

    #[test]
    fn test_task_deserialize_minimal() {
        let json = r#"{
            "title": "Minimal",
            "level": "task",
            "status": "todo"
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert_eq!(task.title, "Minimal");
        assert_eq!(task.level, Level::Task);
        assert_eq!(task.status, Status::Todo);
        assert!(task.priority.is_none());
        assert!(task.tags.is_empty());
        assert!(task.sections.is_empty());
        assert!(task.code_refs.is_empty());
    }

    #[test]
    fn test_task_clone_and_eq() {
        let task = Task::new("Test", Level::Task)
            .with_priority(Priority::High)
            .with_tag("test");
        let cloned = task.clone();
        assert_eq!(task, cloned);
    }

    #[test]
    fn test_task_eq_ignores_timestamps() {
        let task1 = Task::new("Test", Level::Task);
        let mut task2 = Task::new("Test", Level::Task);
        task2.created_at = Some(Utc::now());
        // Tasks should be equal even with different timestamps
        assert_eq!(task1, task2);
    }

    #[test]
    fn test_task_with_full_sections() {
        let task = Task::new("Feature Implementation", Level::Ticket)
            .with_section(Section::new(SectionType::Goal, "Implement the feature"))
            .with_section(Section::new(SectionType::Context, "Background info"))
            .with_section(Section::new(
                SectionType::CurrentBehavior,
                "Currently does nothing",
            ))
            .with_section(Section::new(
                SectionType::DesiredBehavior,
                "Should do something",
            ))
            .with_section(Section::with_order(SectionType::Step, "First step", 1))
            .with_section(Section::with_order(SectionType::Step, "Second step", 2))
            .with_section(Section::new(
                SectionType::TestingCriterion,
                "Tests should pass",
            ))
            .with_section(Section::new(SectionType::AntiPattern, "Don't do this"))
            .with_section(Section::new(
                SectionType::FailureTest,
                "Should fail when...",
            ))
            .with_section(Section::new(SectionType::Constraint, "Must be fast"));

        assert_eq!(task.sections.len(), 10);
    }

    #[test]
    fn test_task_with_full_code_refs() {
        let task = Task::new("Code Review", Level::Task)
            .with_code_ref(CodeRef::file("README.md"))
            .with_code_ref(CodeRef::line("src/main.rs", 1))
            .with_code_ref(CodeRef::range("src/lib.rs", 10, 50).with_description("Core logic"));

        assert_eq!(task.code_refs.len(), 3);
        assert_eq!(
            task.code_refs[2].description,
            Some("Core logic".to_string())
        );
    }

    #[test]
    fn test_task_started_at_field() {
        let mut task = Task::new("Test", Level::Task);
        assert!(task.started_at.is_none());

        let now = Utc::now();
        task.started_at = Some(now);
        assert_eq!(task.started_at, Some(now));
    }

    #[test]
    fn test_task_completed_at_field() {
        let mut task = Task::new("Test", Level::Task);
        assert!(task.completed_at.is_none());

        let now = Utc::now();
        task.completed_at = Some(now);
        assert_eq!(task.completed_at, Some(now));
    }

    #[test]
    fn test_task_serialize_with_started_at() {
        let mut task = Task::new("Started Task", Level::Task);
        let now = Utc::now();
        task.started_at = Some(now);

        let value = serde_json::to_value(&task).unwrap();
        assert!(
            value.get("started_at").is_some(),
            "started_at should be serialized"
        );
        // Verify it's a proper ISO8601 datetime string
        let started_at_str = value["started_at"].as_str().unwrap();
        assert!(
            started_at_str.contains('T'),
            "started_at should be ISO8601 format with 'T' separator"
        );
    }

    #[test]
    fn test_task_serialize_with_completed_at() {
        let mut task = Task::new("Completed Task", Level::Task);
        let now = Utc::now();
        task.completed_at = Some(now);

        let value = serde_json::to_value(&task).unwrap();
        assert!(
            value.get("completed_at").is_some(),
            "completed_at should be serialized"
        );
        // Verify it's a proper ISO8601 datetime string
        let completed_at_str = value["completed_at"].as_str().unwrap();
        assert!(
            completed_at_str.contains('T'),
            "completed_at should be ISO8601 format with 'T' separator"
        );
    }

    #[test]
    fn test_task_serialize_without_timestamps_omits_fields() {
        let task = Task::new("No Timestamps", Level::Task);
        let value = serde_json::to_value(&task).unwrap();
        assert!(
            value.get("started_at").is_none(),
            "started_at should be omitted when None"
        );
        assert!(
            value.get("completed_at").is_none(),
            "completed_at should be omitted when None"
        );
    }

    #[test]
    fn test_task_deserialize_with_started_at() {
        let json = r#"{
            "title": "Started Task",
            "level": "task",
            "status": "in_progress",
            "started_at": "2025-01-06T12:00:00Z"
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert!(task.started_at.is_some());
        let started_at = task.started_at.unwrap();
        assert_eq!(started_at.hour(), 12);
    }

    #[test]
    fn test_task_deserialize_with_completed_at() {
        let json = r#"{
            "title": "Completed Task",
            "level": "task",
            "status": "done",
            "completed_at": "2025-01-06T15:30:00Z"
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert!(task.completed_at.is_some());
        let completed_at = task.completed_at.unwrap();
        assert_eq!(completed_at.hour(), 15);
        assert_eq!(completed_at.minute(), 30);
    }

    #[test]
    fn test_task_deserialize_without_timestamps() {
        let json = r#"{
            "title": "No Timestamps",
            "level": "task",
            "status": "todo"
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert!(task.started_at.is_none());
        assert!(task.completed_at.is_none());
    }

    #[test]
    fn test_task_deserialize_with_both_timestamps() {
        let json = r#"{
            "title": "Full Lifecycle Task",
            "level": "task",
            "status": "done",
            "started_at": "2025-01-06T10:00:00Z",
            "completed_at": "2025-01-06T14:00:00Z"
        }"#;

        let task: Task = serde_json::from_str(json).unwrap();
        assert!(task.started_at.is_some());
        assert!(task.completed_at.is_some());
        // completed_at should be after started_at
        let started = task.started_at.unwrap();
        let completed = task.completed_at.unwrap();
        assert!(
            completed > started,
            "completed_at should be after started_at"
        );
    }

    #[test]
    fn test_task_timestamps_are_datetime_type() {
        let mut task = Task::new("Type Check", Level::Task);
        let now: DateTime<Utc> = Utc::now();
        task.started_at = Some(now);
        task.completed_at = Some(now);

        // Verify the types are DateTime<Utc>, not String
        // This is a compile-time check - if it compiles, the types are correct
        let _started: Option<DateTime<Utc>> = task.started_at;
        let _completed: Option<DateTime<Utc>> = task.completed_at;
    }
}
