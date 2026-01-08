//! Import command for importing database from JSONL format
//!
//! Implements the `vtb import` command to import tasks and relations
//! from a JSONL (JSON Lines) file for restoration or migration purposes.

use clap::Args;
use serde::Deserialize;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use vertebrae_db::{Database, DbError, Task};

/// Import database from JSONL format
#[derive(Debug, Args)]
pub struct ImportCommand {
    /// Input file path (reads from stdin if not specified)
    #[arg(short, long)]
    pub input: Option<PathBuf>,

    /// Skip tasks that already exist (by ID)
    #[arg(long, default_value = "false")]
    pub skip_existing: bool,
}

/// A record in the import file
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ImportRecord {
    /// A task record
    #[serde(rename = "task")]
    Task {
        /// The task ID
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

/// Result of the import command
pub struct ImportResult {
    /// Number of tasks imported
    pub tasks_imported: usize,
    /// Number of tasks skipped (already exist)
    pub tasks_skipped: usize,
    /// Number of child_of relations imported
    pub child_of_relations: usize,
    /// Number of depends_on relations imported
    pub depends_on_relations: usize,
    /// Input source
    pub source: String,
}

impl std::fmt::Display for ImportResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "Import complete!")?;
        writeln!(f, "  Tasks imported: {}", self.tasks_imported)?;
        if self.tasks_skipped > 0 {
            writeln!(f, "  Tasks skipped: {}", self.tasks_skipped)?;
        }
        writeln!(f, "  Child relationships: {}", self.child_of_relations)?;
        writeln!(f, "  Dependencies: {}", self.depends_on_relations)?;
        write!(f, "  Source: {}", self.source)
    }
}

impl ImportCommand {
    /// Execute the import command.
    ///
    /// Imports tasks and relationships from JSONL format.
    ///
    /// # Arguments
    ///
    /// * `db` - Reference to the database connection
    ///
    /// # Errors
    ///
    /// Returns `DbError` if database operations fail or file I/O fails.
    pub async fn execute(&self, db: &Database) -> Result<ImportResult, DbError> {
        let (records, source) = self.read_records()?;

        let mut tasks_imported = 0;
        let mut tasks_skipped = 0;
        let mut child_of_relations = 0;
        let mut depends_on_relations = 0;

        // First pass: import all tasks
        for record in &records {
            if let ImportRecord::Task { id, task } = record {
                // Check if task exists
                if db.tasks().exists(id).await? {
                    if self.skip_existing {
                        tasks_skipped += 1;
                        continue;
                    }
                    // If not skipping, we'll overwrite - delete first
                    db.tasks().delete(id).await?;
                }
                db.tasks().create(id, task.as_ref()).await?;
                tasks_imported += 1;
            }
        }

        // Second pass: import relationships (after all tasks exist)
        for record in &records {
            match record {
                ImportRecord::ChildOf { child, parent } => {
                    db.relationships().create_child_of(child, parent).await?;
                    child_of_relations += 1;
                }
                ImportRecord::DependsOn { task, blocker } => {
                    db.relationships().create_depends_on(task, blocker).await?;
                    depends_on_relations += 1;
                }
                ImportRecord::Task { .. } => {
                    // Already handled in first pass
                }
            }
        }

        Ok(ImportResult {
            tasks_imported,
            tasks_skipped,
            child_of_relations,
            depends_on_relations,
            source,
        })
    }

    /// Read records from the input source
    fn read_records(&self) -> Result<(Vec<ImportRecord>, String), DbError> {
        match &self.input {
            Some(path) => {
                let file = std::fs::File::open(path).map_err(|e| DbError::InvalidPath {
                    path: path.clone(),
                    reason: e.to_string(),
                })?;
                let reader = std::io::BufReader::new(file);
                let records = self.parse_lines(reader, path)?;
                Ok((records, path.display().to_string()))
            }
            None => {
                let stdin = std::io::stdin();
                let reader = stdin.lock();
                let path = PathBuf::from("<stdin>");
                let records = self.parse_lines(reader, &path)?;
                Ok((records, "stdin".to_string()))
            }
        }
    }

    /// Parse lines from a reader into records
    fn parse_lines<R: BufRead>(
        &self,
        reader: R,
        path: &Path,
    ) -> Result<Vec<ImportRecord>, DbError> {
        let mut records = Vec::new();
        for (line_num, line) in reader.lines().enumerate() {
            let line = line.map_err(|e| DbError::InvalidPath {
                path: path.to_path_buf(),
                reason: format!("Error reading line {}: {}", line_num + 1, e),
            })?;

            // Skip empty lines
            if line.trim().is_empty() {
                continue;
            }

            let record: ImportRecord =
                serde_json::from_str(&line).map_err(|e| DbError::InvalidPath {
                    path: path.to_path_buf(),
                    reason: format!("Error parsing line {}: {}", line_num + 1, e),
                })?;
            records.push(record);
        }
        Ok(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_import_record_task_deserialization() {
        let json = r#"{"type":"task","id":"abc123","title":"Test task","level":"task","status":"todo","tags":[],"sections":[],"refs":[]}"#;
        let record: ImportRecord = serde_json::from_str(json).unwrap();

        match record {
            ImportRecord::Task { id, task } => {
                assert_eq!(id, "abc123");
                assert_eq!(task.title, "Test task");
            }
            _ => panic!("Expected Task record"),
        }
    }

    #[test]
    fn test_import_record_child_of_deserialization() {
        let json = r#"{"type":"child_of","child":"child123","parent":"parent456"}"#;
        let record: ImportRecord = serde_json::from_str(json).unwrap();

        match record {
            ImportRecord::ChildOf { child, parent } => {
                assert_eq!(child, "child123");
                assert_eq!(parent, "parent456");
            }
            _ => panic!("Expected ChildOf record"),
        }
    }

    #[test]
    fn test_import_record_depends_on_deserialization() {
        let json = r#"{"type":"depends_on","task":"task123","blocker":"blocker456"}"#;
        let record: ImportRecord = serde_json::from_str(json).unwrap();

        match record {
            ImportRecord::DependsOn { task, blocker } => {
                assert_eq!(task, "task123");
                assert_eq!(blocker, "blocker456");
            }
            _ => panic!("Expected DependsOn record"),
        }
    }

    #[test]
    fn test_import_result_display() {
        let result = ImportResult {
            tasks_imported: 10,
            tasks_skipped: 2,
            child_of_relations: 5,
            depends_on_relations: 3,
            source: "backup.jsonl".to_string(),
        };

        let output = format!("{}", result);
        assert!(output.contains("Import complete!"));
        assert!(output.contains("Tasks imported: 10"));
        assert!(output.contains("Tasks skipped: 2"));
        assert!(output.contains("Child relationships: 5"));
        assert!(output.contains("Dependencies: 3"));
        assert!(output.contains("backup.jsonl"));
    }

    #[test]
    fn test_import_result_display_no_skipped() {
        let result = ImportResult {
            tasks_imported: 10,
            tasks_skipped: 0,
            child_of_relations: 5,
            depends_on_relations: 3,
            source: "backup.jsonl".to_string(),
        };

        let output = format!("{}", result);
        assert!(!output.contains("Tasks skipped"));
    }

    #[test]
    fn test_import_command_debug() {
        let cmd = ImportCommand {
            input: Some(PathBuf::from("test.jsonl")),
            skip_existing: true,
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("ImportCommand"));
        assert!(debug_str.contains("test.jsonl"));
        assert!(debug_str.contains("skip_existing"));
    }
}
