//! Export command for exporting database to JSONL format
//!
//! Implements the `vtb export` command to export all tasks and relations
//! to a JSONL (JSON Lines) file for backup or migration purposes.

use clap::Args;
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use vertebrae_db::{Database, DbError, Task};

/// Export database to JSONL format
#[derive(Debug, Args)]
pub struct ExportCommand {
    /// Output file path (defaults to stdout if not specified)
    #[arg(short, long)]
    pub output: Option<PathBuf>,
}

/// A record in the export file
#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub enum ExportRecord {
    /// A task record
    #[serde(rename = "task")]
    Task {
        /// The task ID (without the "task:" prefix)
        id: String,
        /// The task data
        #[serde(flatten)]
        task: Box<Task>,
    },
    /// A parent-child relationship
    #[serde(rename = "child_of")]
    ChildOf {
        /// The child task ID
        child: String,
        /// The parent task ID
        parent: String,
    },
    /// A dependency relationship
    #[serde(rename = "depends_on")]
    DependsOn {
        /// The task that depends on another
        task: String,
        /// The task it depends on (the blocker)
        blocker: String,
    },
}

/// Result of the export command
pub struct ExportResult {
    /// Number of tasks exported
    pub tasks: usize,
    /// Number of child_of relations exported
    pub child_of_relations: usize,
    /// Number of depends_on relations exported
    pub depends_on_relations: usize,
    /// Output destination
    pub destination: String,
}

impl std::fmt::Display for ExportResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "Export complete!")?;
        writeln!(f, "  Tasks: {}", self.tasks)?;
        writeln!(f, "  Child relationships: {}", self.child_of_relations)?;
        writeln!(f, "  Dependencies: {}", self.depends_on_relations)?;
        write!(f, "  Output: {}", self.destination)
    }
}

impl ExportCommand {
    /// Execute the export command.
    ///
    /// Exports all tasks and relationships to JSONL format.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if database queries fail or file I/O fails.
    pub async fn execute(&self, db: &Database) -> Result<ExportResult, DbError> {
        // Collect all records to export
        let mut records: Vec<ExportRecord> = Vec::new();

        // Export all tasks using repository
        let tasks = db.tasks().export_all().await?;
        let task_count = tasks.len();
        for (id, task) in tasks {
            records.push(ExportRecord::Task {
                id,
                task: Box::new(task),
            });
        }

        // Export child_of relationships using repository
        let child_of_relations = db.relationships().export_all_child_of().await?;
        let child_of_count = child_of_relations.len();
        for (child, parent) in child_of_relations {
            records.push(ExportRecord::ChildOf { child, parent });
        }

        // Export depends_on relationships using repository
        let depends_on_relations = db.relationships().export_all_depends_on().await?;
        let depends_on_count = depends_on_relations.len();
        for (task, blocker) in depends_on_relations {
            records.push(ExportRecord::DependsOn { task, blocker });
        }

        // Write to output
        let destination = self.write_records(&records)?;

        Ok(ExportResult {
            tasks: task_count,
            child_of_relations: child_of_count,
            depends_on_relations: depends_on_count,
            destination,
        })
    }

    /// Write records to the output destination
    fn write_records(&self, records: &[ExportRecord]) -> Result<String, DbError> {
        match &self.output {
            Some(path) => {
                let file = std::fs::File::create(path).map_err(|e| DbError::InvalidPath {
                    path: path.clone(),
                    reason: e.to_string(),
                })?;
                let mut writer = std::io::BufWriter::new(file);

                for record in records {
                    let json = serde_json::to_string(record).map_err(|e| DbError::InvalidPath {
                        path: path.clone(),
                        reason: format!("JSON serialization error: {}", e),
                    })?;
                    writeln!(writer, "{}", json).map_err(|e| DbError::InvalidPath {
                        path: path.clone(),
                        reason: e.to_string(),
                    })?;
                }

                Ok(path.display().to_string())
            }
            None => {
                // Write to stdout
                for record in records {
                    let json = serde_json::to_string(record).map_err(|e| DbError::InvalidPath {
                        path: PathBuf::from("<stdout>"),
                        reason: format!("JSON serialization error: {}", e),
                    })?;
                    println!("{}", json);
                }
                Ok("stdout".to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_export_record_task_serialization() {
        use vertebrae_db::{Level, Status};

        let task = Task::new("Test task", Level::Task).with_status(Status::Todo);

        let record = ExportRecord::Task {
            id: "abc123".to_string(),
            task: Box::new(task),
        };

        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains(r#""type":"task""#));
        assert!(json.contains(r#""id":"abc123""#));
        assert!(json.contains(r#""title":"Test task""#));
    }

    #[test]
    fn test_export_record_child_of_serialization() {
        let record = ExportRecord::ChildOf {
            child: "child123".to_string(),
            parent: "parent456".to_string(),
        };

        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains(r#""type":"child_of""#));
        assert!(json.contains(r#""child":"child123""#));
        assert!(json.contains(r#""parent":"parent456""#));
    }

    #[test]
    fn test_export_record_depends_on_serialization() {
        let record = ExportRecord::DependsOn {
            task: "task123".to_string(),
            blocker: "blocker456".to_string(),
        };

        let json = serde_json::to_string(&record).unwrap();
        assert!(json.contains(r#""type":"depends_on""#));
        assert!(json.contains(r#""task":"task123""#));
        assert!(json.contains(r#""blocker":"blocker456""#));
    }

    #[test]
    fn test_export_result_display() {
        let result = ExportResult {
            tasks: 10,
            child_of_relations: 5,
            depends_on_relations: 3,
            destination: "backup.jsonl".to_string(),
        };

        let output = format!("{}", result);
        assert!(output.contains("Export complete!"));
        assert!(output.contains("Tasks: 10"));
        assert!(output.contains("Child relationships: 5"));
        assert!(output.contains("Dependencies: 3"));
        assert!(output.contains("backup.jsonl"));
    }

    #[test]
    fn test_export_command_debug() {
        let cmd = ExportCommand {
            output: Some(PathBuf::from("test.jsonl")),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("ExportCommand"));
        assert!(debug_str.contains("test.jsonl"));
    }
}
