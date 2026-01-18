//! StatusSchema commands for viewing status schema definitions
//!
//! Implements the `vtb status-schema` subcommand group for listing and showing status schemas.

use clap::{Args, Subcommand};
use vertebrae_core::{ServiceError, TaskService};
use vertebrae_db::DEFAULT_STATUS_SCHEMA_ID;

/// StatusSchema management commands
#[derive(Debug, Subcommand)]
pub enum StatusSchemaCommand {
    /// List all status schemas
    List(StatusSchemaListCommand),
    /// Show details of a specific status schema
    Show(StatusSchemaShowCommand),
}

impl StatusSchemaCommand {
    /// Execute the status-schema subcommand.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if the command execution fails.
    pub async fn execute(&self, service: &dyn TaskService) -> Result<String, ServiceError> {
        match self {
            StatusSchemaCommand::List(cmd) => cmd.execute(service).await,
            StatusSchemaCommand::Show(cmd) => cmd.execute(service).await,
        }
    }
}

/// List all status schemas
#[derive(Debug, Args)]
pub struct StatusSchemaListCommand {}

impl StatusSchemaListCommand {
    /// Execute the list status schemas command.
    ///
    /// Lists all available status schemas with their names, default status, and status count.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - Database operations fail
    pub async fn execute(&self, service: &dyn TaskService) -> Result<String, ServiceError> {
        #[allow(deprecated)]
        let db = service.database();
        let schemas = db.status_schemas().list().await?;

        if schemas.is_empty() {
            return Ok("No status schemas found.".to_string());
        }

        let mut output = String::new();
        output.push_str("Status Schemas:\n");
        output.push_str(&format!(
            "{:<12} {:<20} {:<10} {:<8} {}\n",
            "ID", "Name", "Default", "Statuses", "Description"
        ));
        output.push_str(&"-".repeat(80));
        output.push('\n');

        for schema in schemas {
            let id = schema
                .id
                .as_ref()
                .map(|t| t.id.to_raw())
                .unwrap_or_else(|| "?".to_string());
            let default_marker = if schema.is_default { "yes" } else { "no" };
            let desc = schema.description.as_deref().unwrap_or("-");
            let desc_truncated = if desc.len() > 30 {
                format!("{}...", &desc[..27])
            } else {
                desc.to_string()
            };

            output.push_str(&format!(
                "{:<12} {:<20} {:<10} {:<8} {}\n",
                id,
                schema.name,
                default_marker,
                schema.statuses.len(),
                desc_truncated
            ));
        }

        Ok(output)
    }
}

/// Show details of a specific status schema
#[derive(Debug, Args)]
pub struct StatusSchemaShowCommand {
    /// ID of the status schema to show (use 'default' for the default schema)
    #[arg(default_value = DEFAULT_STATUS_SCHEMA_ID)]
    pub id: String,
}

impl StatusSchemaShowCommand {
    /// Execute the show status schema command.
    ///
    /// Displays detailed information about a specific status schema including
    /// all status definitions and progression rules.
    ///
    /// # Arguments
    ///
    /// * `service` - Reference to the task service
    ///
    /// # Errors
    ///
    /// Returns `ServiceError` if:
    /// - The schema is not found
    /// - Database operations fail
    pub async fn execute(&self, service: &dyn TaskService) -> Result<String, ServiceError> {
        #[allow(deprecated)]
        let db = service.database();
        let schema = db.status_schemas().get(&self.id).await?;

        let schema = schema.ok_or_else(|| {
            ServiceError::validation_failed(format!("Status schema '{}' not found", self.id))
        })?;

        let mut output = String::new();

        // Header
        output.push_str(&format!("Status Schema: {}\n", schema.name));
        output.push_str(&"=".repeat(60));
        output.push('\n');

        // Basic info
        if let Some(desc) = &schema.description {
            output.push_str(&format!("Description: {}\n", desc));
        }
        output.push_str(&format!(
            "Default: {}\n",
            if schema.is_default { "yes" } else { "no" }
        ));
        output.push('\n');

        // Status definitions
        output.push_str("Statuses:\n");
        output.push_str(&"-".repeat(60));
        output.push('\n');

        // Sort by order
        let mut statuses = schema.statuses.clone();
        statuses.sort_by_key(|s| s.order);

        for status in &statuses {
            output.push_str(&format!("  {}. {}", status.order, status.name));
            if let Some(label) = &status.label
                && label != &status.name
            {
                output.push_str(&format!(" ({})", label));
            }

            let mut flags = Vec::new();
            if status.is_terminal {
                flags.push("terminal");
            }
            if status.unblocks_dependents {
                flags.push("unblocks");
            }

            if !flags.is_empty() {
                output.push_str(&format!(" [{}]", flags.join(", ")));
            }

            output.push('\n');

            if let Some(desc) = &status.description {
                output.push_str(&format!("     {}\n", desc));
            }

            if let Some(color) = &status.color {
                output.push_str(&format!("     Color: {}\n", color));
            }
        }

        output.push('\n');

        // Progressions
        output.push_str("Progressions:\n");
        output.push_str(&"-".repeat(60));
        output.push('\n');

        if schema.progressions.is_empty() {
            output.push_str("  (no progressions defined)\n");
        } else {
            for prog in &schema.progressions {
                let label = prog
                    .label
                    .as_ref()
                    .map(|l| format!(" \"{}\"", l))
                    .unwrap_or_default();

                let validation = if prog.requires_validation {
                    " [requires validation]"
                } else {
                    ""
                };

                output.push_str(&format!(
                    "  {} -> {}{}{}\n",
                    prog.from_status, prog.to_status, label, validation
                ));
            }
        }

        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_schema_list_command_debug() {
        let cmd = StatusSchemaListCommand {};
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("StatusSchemaListCommand"));
    }

    #[test]
    fn test_status_schema_show_command_default_id() {
        let cmd = StatusSchemaShowCommand {
            id: DEFAULT_STATUS_SCHEMA_ID.to_string(),
        };
        assert_eq!(cmd.id, "default");
    }

    #[test]
    fn test_status_schema_show_command_custom_id() {
        let cmd = StatusSchemaShowCommand {
            id: "custom".to_string(),
        };
        assert_eq!(cmd.id, "custom");
    }

    #[test]
    fn test_status_schema_show_command_debug() {
        let cmd = StatusSchemaShowCommand {
            id: "test".to_string(),
        };
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("StatusSchemaShowCommand"));
        assert!(debug_str.contains("test"));
    }

    #[test]
    fn test_status_schema_command_debug() {
        let cmd = StatusSchemaCommand::List(StatusSchemaListCommand {});
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("List"));
    }
}
