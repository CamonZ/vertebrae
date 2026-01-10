//! Triage validation for task state transitions
//!
//! Provides validation logic for transitioning tasks from backlog to todo,
//! ensuring tasks have required sections before being triaged.

use crate::models::{Section, SectionType, Task};

/// Severity level for validation issues
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationSeverity {
    /// Required sections - blocks transition
    Error,
    /// Encouraged sections - warns but allows transition
    Warning,
    /// Recommended sections - notes for improvement
    Note,
}

/// A single validation issue found during triage validation
#[derive(Debug, Clone)]
pub struct ValidationIssue {
    /// The section type that has an issue
    pub section_type: SectionType,
    /// The severity of this issue
    pub severity: ValidationSeverity,
    /// Human-readable description of the issue
    pub message: String,
    /// Current count of this section type
    pub current_count: usize,
    /// Required minimum count (if applicable)
    pub required_count: Option<usize>,
}

impl ValidationIssue {
    /// Create a new validation issue for a missing required section
    pub fn missing_required(section_type: SectionType, required: usize, current: usize) -> Self {
        Self {
            section_type: section_type.clone(),
            severity: ValidationSeverity::Error,
            message: format!(
                "Required: at least {} {}(s), found {}",
                required,
                section_type.as_str(),
                current
            ),
            current_count: current,
            required_count: Some(required),
        }
    }

    /// Create a new validation issue for missing any of the required section types (OR logic)
    pub fn missing_required_any(
        section_types: Vec<SectionType>,
        required: usize,
        current: usize,
    ) -> Self {
        let type_names: Vec<&str> = section_types.iter().map(|t| t.as_str()).collect();
        let primary = section_types.first().cloned().unwrap_or(SectionType::Goal);
        Self {
            section_type: primary,
            severity: ValidationSeverity::Error,
            message: format!(
                "Required: at least {} of [{}], found {}",
                required,
                type_names.join(" OR "),
                current
            ),
            current_count: current,
            required_count: Some(required),
        }
    }

    /// Create a new validation issue for a missing encouraged section
    pub fn missing_encouraged(
        section_type: SectionType,
        recommended: usize,
        current: usize,
    ) -> Self {
        Self {
            section_type: section_type.clone(),
            severity: ValidationSeverity::Warning,
            message: format!(
                "Encouraged: at least {} {}(s), found {}",
                recommended,
                section_type.as_str(),
                current
            ),
            current_count: current,
            required_count: Some(recommended),
        }
    }

    /// Create a new validation issue for a missing recommended section
    pub fn missing_recommended(section_type: SectionType) -> Self {
        Self {
            section_type: section_type.clone(),
            severity: ValidationSeverity::Note,
            message: format!("Recommended: add a {} section", section_type.as_str()),
            current_count: 0,
            required_count: None,
        }
    }
}

/// Rule for validating a specific section type
#[derive(Debug, Clone)]
pub struct SectionRule {
    /// The section type this rule applies to (for single-type rules)
    pub section_type: SectionType,
    /// Alternative section types that satisfy this rule (OR logic)
    pub alternatives: Vec<SectionType>,
    /// Minimum required count (None means not required)
    pub min_count: Option<usize>,
    /// Severity if the rule is not met
    pub severity: ValidationSeverity,
    /// Description of why this section is important
    pub description: Option<String>,
}

impl SectionRule {
    /// Create a required section rule
    pub fn required(section_type: SectionType, min_count: usize) -> Self {
        Self {
            section_type,
            alternatives: Vec::new(),
            min_count: Some(min_count),
            severity: ValidationSeverity::Error,
            description: None,
        }
    }

    /// Create a required rule where any of the given types satisfies it (OR logic)
    pub fn required_any(section_types: Vec<SectionType>, min_count: usize) -> Self {
        let primary = section_types.first().cloned().unwrap_or(SectionType::Goal);
        let alternatives = section_types.into_iter().skip(1).collect();
        Self {
            section_type: primary,
            alternatives,
            min_count: Some(min_count),
            severity: ValidationSeverity::Error,
            description: None,
        }
    }

    /// Create an encouraged section rule
    pub fn encouraged(section_type: SectionType, min_count: usize) -> Self {
        Self {
            section_type,
            alternatives: Vec::new(),
            min_count: Some(min_count),
            severity: ValidationSeverity::Warning,
            description: None,
        }
    }

    /// Create a recommended section rule (presence check only)
    pub fn recommended(section_type: SectionType) -> Self {
        Self {
            section_type,
            alternatives: Vec::new(),
            min_count: Some(1),
            severity: ValidationSeverity::Note,
            description: None,
        }
    }

    /// Add a description to this rule
    pub fn with_description(mut self, desc: impl Into<String>) -> Self {
        self.description = Some(desc.into());
        self
    }

    /// Check if this rule has alternatives (OR logic)
    pub fn has_alternatives(&self) -> bool {
        !self.alternatives.is_empty()
    }

    /// Get all section types this rule accepts (primary + alternatives)
    pub fn all_types(&self) -> Vec<&SectionType> {
        let mut types = vec![&self.section_type];
        types.extend(self.alternatives.iter());
        types
    }
}

/// Configuration for triage validation rules
#[derive(Debug, Clone)]
pub struct TriageValidationConfig {
    /// Rules for section validation
    pub rules: Vec<SectionRule>,
}

impl Default for TriageValidationConfig {
    fn default() -> Self {
        Self::new()
    }
}

impl TriageValidationConfig {
    /// Create the default triage validation configuration
    ///
    /// Required sections (block if missing):
    /// - goal OR desired_behavior (>=1) - clear objective
    /// - testing_criterion (>=2) - at least one unit AND one integration test criterion
    /// - step (>=1) - implementation steps
    /// - constraint (>=2) - must include architectural guidelines + test quality rules
    ///
    /// Encouraged (warn but allow):
    /// - anti_pattern (>=1) - what to avoid
    /// - failure_test (>=1) - expected error scenarios
    ///
    /// Recommended (note if missing):
    /// - context - background info
    /// - current_behavior - for changes/bugs
    pub fn new() -> Self {
        Self {
            rules: vec![
                // Required sections
                SectionRule::required_any(vec![SectionType::Goal, SectionType::DesiredBehavior], 1)
                    .with_description("clear objective (goal or desired_behavior)"),
                SectionRule::required(SectionType::TestingCriterion, 2)
                    .with_description("at least one unit AND one integration test criterion"),
                SectionRule::required(SectionType::Step, 1)
                    .with_description("implementation steps"),
                SectionRule::required(SectionType::Constraint, 2)
                    .with_description("architectural guidelines + test quality rules"),
                // Encouraged sections
                SectionRule::encouraged(SectionType::AntiPattern, 1)
                    .with_description("what to avoid"),
                SectionRule::encouraged(SectionType::FailureTest, 1)
                    .with_description("expected error scenarios"),
                // Recommended sections
                SectionRule::recommended(SectionType::Context).with_description("background info"),
                SectionRule::recommended(SectionType::CurrentBehavior)
                    .with_description("for changes/bugs"),
            ],
        }
    }

    /// Add a custom rule to the configuration
    pub fn with_rule(mut self, rule: SectionRule) -> Self {
        self.rules.push(rule);
        self
    }
}

/// Result of validating a task for triage
#[derive(Debug, Clone)]
pub struct TriageValidationResult {
    /// The task ID that was validated
    pub task_id: String,
    /// All validation issues found
    pub issues: Vec<ValidationIssue>,
}

impl TriageValidationResult {
    /// Create a new validation result
    pub fn new(task_id: impl Into<String>) -> Self {
        Self {
            task_id: task_id.into(),
            issues: Vec::new(),
        }
    }

    /// Check if validation passed (no errors)
    pub fn is_valid(&self) -> bool {
        !self.has_errors()
    }

    /// Check if there are any blocking errors
    pub fn has_errors(&self) -> bool {
        self.issues
            .iter()
            .any(|i| i.severity == ValidationSeverity::Error)
    }

    /// Check if there are any warnings
    pub fn has_warnings(&self) -> bool {
        self.issues
            .iter()
            .any(|i| i.severity == ValidationSeverity::Warning)
    }

    /// Check if there are any notes
    pub fn has_notes(&self) -> bool {
        self.issues
            .iter()
            .any(|i| i.severity == ValidationSeverity::Note)
    }

    /// Get all errors
    pub fn errors(&self) -> Vec<&ValidationIssue> {
        self.issues
            .iter()
            .filter(|i| i.severity == ValidationSeverity::Error)
            .collect()
    }

    /// Get all warnings
    pub fn warnings(&self) -> Vec<&ValidationIssue> {
        self.issues
            .iter()
            .filter(|i| i.severity == ValidationSeverity::Warning)
            .collect()
    }

    /// Get all notes
    pub fn notes(&self) -> Vec<&ValidationIssue> {
        self.issues
            .iter()
            .filter(|i| i.severity == ValidationSeverity::Note)
            .collect()
    }

    /// Get the count of errors
    pub fn error_count(&self) -> usize {
        self.errors().len()
    }

    /// Get the count of warnings
    pub fn warning_count(&self) -> usize {
        self.warnings().len()
    }

    /// Get the count of notes
    pub fn note_count(&self) -> usize {
        self.notes().len()
    }
}

impl std::fmt::Display for TriageValidationResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.issues.is_empty() {
            return write!(f, "Validation passed for task '{}'", self.task_id);
        }

        let errors = self.errors();
        let warnings = self.warnings();
        let notes = self.notes();

        if !errors.is_empty() {
            writeln!(f, "ERRORS ({}):", errors.len())?;
            for issue in &errors {
                writeln!(f, "  - {}", issue.message)?;
            }
        }

        if !warnings.is_empty() {
            if !errors.is_empty() {
                writeln!(f)?;
            }
            writeln!(f, "WARNINGS ({}):", warnings.len())?;
            for issue in &warnings {
                writeln!(f, "  - {}", issue.message)?;
            }
        }

        if !notes.is_empty() {
            if !errors.is_empty() || !warnings.is_empty() {
                writeln!(f)?;
            }
            writeln!(f, "NOTES ({}):", notes.len())?;
            for issue in &notes {
                writeln!(f, "  - {}", issue.message)?;
            }
        }

        Ok(())
    }
}

/// Validator for triage operations
#[derive(Debug, Clone)]
pub struct TriageValidator {
    config: TriageValidationConfig,
}

impl Default for TriageValidator {
    fn default() -> Self {
        Self::new()
    }
}

impl TriageValidator {
    /// Create a new validator with default configuration
    pub fn new() -> Self {
        Self {
            config: TriageValidationConfig::default(),
        }
    }

    /// Create a validator with custom configuration
    pub fn with_config(config: TriageValidationConfig) -> Self {
        Self { config }
    }

    /// Count sections of a specific type
    fn count_sections(sections: &[Section], section_type: &SectionType) -> usize {
        sections
            .iter()
            .filter(|s| &s.section_type == section_type)
            .count()
    }

    /// Count sections matching any of the given types
    fn count_sections_any(sections: &[Section], types: &[&SectionType]) -> usize {
        sections
            .iter()
            .filter(|s| types.contains(&&s.section_type))
            .count()
    }

    /// Validate a task for triage
    pub fn validate(&self, task: &Task) -> TriageValidationResult {
        let task_id = task
            .id
            .as_ref()
            .map(|t| t.id.to_raw())
            .unwrap_or_else(|| "unknown".to_string());

        let mut result = TriageValidationResult::new(task_id);

        for rule in &self.config.rules {
            // Count sections - if rule has alternatives, count any of them
            let count = if rule.has_alternatives() {
                Self::count_sections_any(&task.sections, &rule.all_types())
            } else {
                Self::count_sections(&task.sections, &rule.section_type)
            };

            if let Some(min_count) = rule.min_count
                && count < min_count
            {
                let issue = match rule.severity {
                    ValidationSeverity::Error => {
                        if rule.has_alternatives() {
                            ValidationIssue::missing_required_any(
                                rule.all_types().iter().map(|t| (*t).clone()).collect(),
                                min_count,
                                count,
                            )
                        } else {
                            ValidationIssue::missing_required(
                                rule.section_type.clone(),
                                min_count,
                                count,
                            )
                        }
                    }
                    ValidationSeverity::Warning => ValidationIssue::missing_encouraged(
                        rule.section_type.clone(),
                        min_count,
                        count,
                    ),
                    ValidationSeverity::Note => {
                        ValidationIssue::missing_recommended(rule.section_type.clone())
                    }
                };
                result.issues.push(issue);
            }
        }

        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Level, Section};

    fn create_task_with_sections(sections: Vec<Section>) -> Task {
        let mut task = Task::new("Test Task", Level::Ticket);
        task.sections = sections;
        task
    }

    #[test]
    fn test_validation_severity_equality() {
        assert_eq!(ValidationSeverity::Error, ValidationSeverity::Error);
        assert_eq!(ValidationSeverity::Warning, ValidationSeverity::Warning);
        assert_eq!(ValidationSeverity::Note, ValidationSeverity::Note);
        assert_ne!(ValidationSeverity::Error, ValidationSeverity::Warning);
    }

    #[test]
    fn test_validation_issue_missing_required() {
        let issue = ValidationIssue::missing_required(SectionType::TestingCriterion, 2, 1);
        assert_eq!(issue.severity, ValidationSeverity::Error);
        assert_eq!(issue.current_count, 1);
        assert_eq!(issue.required_count, Some(2));
        assert!(issue.message.contains("Required"));
        assert!(issue.message.contains("testing_criterion"));
    }

    #[test]
    fn test_validation_issue_missing_encouraged() {
        let issue = ValidationIssue::missing_encouraged(SectionType::AntiPattern, 1, 0);
        assert_eq!(issue.severity, ValidationSeverity::Warning);
        assert_eq!(issue.current_count, 0);
        assert!(issue.message.contains("Encouraged"));
    }

    #[test]
    fn test_validation_issue_missing_recommended() {
        let issue = ValidationIssue::missing_recommended(SectionType::Goal);
        assert_eq!(issue.severity, ValidationSeverity::Note);
        assert_eq!(issue.current_count, 0);
        assert!(issue.message.contains("Recommended"));
    }

    #[test]
    fn test_section_rule_required() {
        let rule = SectionRule::required(SectionType::Step, 3);
        assert_eq!(rule.min_count, Some(3));
        assert_eq!(rule.severity, ValidationSeverity::Error);
    }

    #[test]
    fn test_section_rule_encouraged() {
        let rule = SectionRule::encouraged(SectionType::AntiPattern, 1);
        assert_eq!(rule.min_count, Some(1));
        assert_eq!(rule.severity, ValidationSeverity::Warning);
    }

    #[test]
    fn test_section_rule_recommended() {
        let rule = SectionRule::recommended(SectionType::Context);
        assert_eq!(rule.min_count, Some(1));
        assert_eq!(rule.severity, ValidationSeverity::Note);
    }

    #[test]
    fn test_section_rule_with_description() {
        let rule = SectionRule::required(SectionType::Step, 1).with_description("test description");
        assert_eq!(rule.description, Some("test description".to_string()));
    }

    #[test]
    fn test_triage_validation_config_default() {
        let config = TriageValidationConfig::default();
        assert!(!config.rules.is_empty());

        // Check for goal/desired_behavior OR rule
        let has_goal_or_desired = config.rules.iter().any(|r| {
            r.section_type == SectionType::Goal
                && r.alternatives.contains(&SectionType::DesiredBehavior)
                && r.min_count == Some(1)
                && r.severity == ValidationSeverity::Error
        });
        assert!(
            has_goal_or_desired,
            "Should require goal OR desired_behavior"
        );

        // Check for required section rules
        let has_testing_criterion = config.rules.iter().any(|r| {
            r.section_type == SectionType::TestingCriterion
                && r.min_count == Some(2)
                && r.severity == ValidationSeverity::Error
        });
        assert!(
            has_testing_criterion,
            "Should require 2 testing_criterion sections"
        );

        let has_step = config.rules.iter().any(|r| {
            r.section_type == SectionType::Step
                && r.min_count == Some(1)
                && r.severity == ValidationSeverity::Error
        });
        assert!(has_step, "Should require at least 1 step section");

        let has_constraint = config.rules.iter().any(|r| {
            r.section_type == SectionType::Constraint
                && r.min_count == Some(2)
                && r.severity == ValidationSeverity::Error
        });
        assert!(has_constraint, "Should require 2 constraint sections");
    }

    #[test]
    fn test_triage_validation_config_with_rule() {
        let config = TriageValidationConfig::default()
            .with_rule(SectionRule::required(SectionType::Goal, 3));

        let has_goal_rule = config
            .rules
            .iter()
            .any(|r| r.section_type == SectionType::Goal && r.min_count == Some(3));
        assert!(has_goal_rule, "Should have custom goal rule");
    }

    #[test]
    fn test_triage_validation_result_new() {
        let result = TriageValidationResult::new("task123");
        assert_eq!(result.task_id, "task123");
        assert!(result.issues.is_empty());
        assert!(result.is_valid());
    }

    #[test]
    fn test_triage_validation_result_has_errors() {
        let mut result = TriageValidationResult::new("task123");
        assert!(!result.has_errors());

        result
            .issues
            .push(ValidationIssue::missing_required(SectionType::Step, 1, 0));
        assert!(result.has_errors());
        assert!(!result.is_valid());
    }

    #[test]
    fn test_triage_validation_result_has_warnings() {
        let mut result = TriageValidationResult::new("task123");
        assert!(!result.has_warnings());

        result.issues.push(ValidationIssue::missing_encouraged(
            SectionType::AntiPattern,
            1,
            0,
        ));
        assert!(result.has_warnings());
        assert!(result.is_valid()); // Warnings don't block
    }

    #[test]
    fn test_triage_validation_result_has_notes() {
        let mut result = TriageValidationResult::new("task123");
        assert!(!result.has_notes());

        result
            .issues
            .push(ValidationIssue::missing_recommended(SectionType::Goal));
        assert!(result.has_notes());
        assert!(result.is_valid()); // Notes don't block
    }

    #[test]
    fn test_triage_validation_result_counts() {
        let mut result = TriageValidationResult::new("task123");
        result
            .issues
            .push(ValidationIssue::missing_required(SectionType::Step, 1, 0));
        result.issues.push(ValidationIssue::missing_required(
            SectionType::TestingCriterion,
            2,
            1,
        ));
        result.issues.push(ValidationIssue::missing_encouraged(
            SectionType::AntiPattern,
            1,
            0,
        ));
        result
            .issues
            .push(ValidationIssue::missing_recommended(SectionType::Goal));

        assert_eq!(result.error_count(), 2);
        assert_eq!(result.warning_count(), 1);
        assert_eq!(result.note_count(), 1);
    }

    #[test]
    fn test_triage_validation_result_display_empty() {
        let result = TriageValidationResult::new("task123");
        let output = format!("{}", result);
        assert!(output.contains("Validation passed"));
        assert!(output.contains("task123"));
    }

    #[test]
    fn test_triage_validation_result_display_with_issues() {
        let mut result = TriageValidationResult::new("task123");
        result
            .issues
            .push(ValidationIssue::missing_required(SectionType::Step, 1, 0));
        result.issues.push(ValidationIssue::missing_encouraged(
            SectionType::AntiPattern,
            1,
            0,
        ));
        result
            .issues
            .push(ValidationIssue::missing_recommended(SectionType::Goal));

        let output = format!("{}", result);
        assert!(output.contains("ERRORS (1):"));
        assert!(output.contains("WARNINGS (1):"));
        assert!(output.contains("NOTES (1):"));
    }

    #[test]
    fn test_triage_validator_new() {
        let validator = TriageValidator::new();
        // Default validator should have rules from default config
        assert!(!validator.config.rules.is_empty());
    }

    #[test]
    fn test_triage_validator_with_config() {
        let config = TriageValidationConfig {
            rules: vec![SectionRule::required(SectionType::Goal, 1)],
        };
        let validator = TriageValidator::with_config(config);
        assert_eq!(validator.config.rules.len(), 1);
    }

    #[test]
    fn test_triage_validator_count_sections() {
        let sections = vec![
            Section::new(SectionType::Step, "Step 1"),
            Section::new(SectionType::Step, "Step 2"),
            Section::new(SectionType::Goal, "Goal"),
        ];

        assert_eq!(
            TriageValidator::count_sections(&sections, &SectionType::Step),
            2
        );
        assert_eq!(
            TriageValidator::count_sections(&sections, &SectionType::Goal),
            1
        );
        assert_eq!(
            TriageValidator::count_sections(&sections, &SectionType::Context),
            0
        );
    }

    #[test]
    fn test_triage_validator_validate_empty_task() {
        let validator = TriageValidator::new();
        let task = create_task_with_sections(vec![]);

        let result = validator.validate(&task);
        assert!(!result.is_valid());
        assert!(result.has_errors());

        // Should have errors for missing required sections
        let errors = result.errors();
        assert!(
            errors.len() >= 3,
            "Should have at least 3 errors for testing_criterion, step, constraint"
        );
    }

    #[test]
    fn test_triage_validator_validate_valid_task() {
        let validator = TriageValidator::new();
        let task = create_task_with_sections(vec![
            // Required sections
            Section::new(SectionType::TestingCriterion, "Unit test: verify X"),
            Section::new(SectionType::TestingCriterion, "Integration test: verify Y"),
            Section::new(SectionType::Step, "Step 1: implement feature"),
            Section::new(SectionType::Constraint, "Must follow pattern A"),
            Section::new(
                SectionType::Constraint,
                "Tests must have specific assertions",
            ),
            // Encouraged sections
            Section::new(SectionType::AntiPattern, "Don't use hardcoded values"),
            Section::new(SectionType::FailureTest, "Should fail with invalid input"),
            // Recommended sections
            Section::new(SectionType::Goal, "Implement feature X"),
            Section::new(SectionType::Context, "Background info"),
        ]);

        let result = validator.validate(&task);
        assert!(
            result.is_valid(),
            "Validation should pass: {:?}",
            result.issues
        );
        assert!(!result.has_errors());
        assert!(!result.has_warnings());
    }

    #[test]
    fn test_triage_validator_validate_missing_encouraged() {
        let validator = TriageValidator::new();
        let task = create_task_with_sections(vec![
            // Required sections only
            Section::new(SectionType::TestingCriterion, "Test 1"),
            Section::new(SectionType::TestingCriterion, "Test 2"),
            Section::new(SectionType::Step, "Step 1"),
            Section::new(SectionType::Constraint, "Constraint 1"),
            Section::new(SectionType::Constraint, "Constraint 2"),
            // Add recommended sections to avoid notes
            Section::new(SectionType::Goal, "Goal"),
            Section::new(SectionType::Context, "Context"),
            Section::new(SectionType::CurrentBehavior, "Current"),
            Section::new(SectionType::DesiredBehavior, "Desired"),
        ]);

        let result = validator.validate(&task);
        assert!(result.is_valid(), "Should pass - warnings don't block");
        assert!(!result.has_errors());
        assert!(
            result.has_warnings(),
            "Should warn about missing encouraged sections"
        );
    }

    #[test]
    fn test_triage_validator_validate_missing_recommended() {
        let validator = TriageValidator::new();
        let task = create_task_with_sections(vec![
            // Required sections
            Section::new(SectionType::Goal, "Clear objective"),
            Section::new(SectionType::TestingCriterion, "Test 1"),
            Section::new(SectionType::TestingCriterion, "Test 2"),
            Section::new(SectionType::Step, "Step 1"),
            Section::new(SectionType::Constraint, "Constraint 1"),
            Section::new(SectionType::Constraint, "Constraint 2"),
            // Encouraged sections
            Section::new(SectionType::AntiPattern, "Don't do X"),
            Section::new(SectionType::FailureTest, "Fails with Y"),
            // No context or current_behavior - should have notes
        ]);

        let result = validator.validate(&task);
        assert!(result.is_valid(), "Should pass - notes don't block");
        assert!(!result.has_errors());
        assert!(!result.has_warnings());
        assert!(
            result.has_notes(),
            "Should have notes about missing recommended sections"
        );
    }

    #[test]
    fn test_triage_validator_validate_insufficient_count() {
        let validator = TriageValidator::new();
        let task = create_task_with_sections(vec![
            // Only 1 testing_criterion (needs 2)
            Section::new(SectionType::TestingCriterion, "Test 1"),
            Section::new(SectionType::Step, "Step 1"),
            // Only 1 constraint (needs 2)
            Section::new(SectionType::Constraint, "Constraint 1"),
        ]);

        let result = validator.validate(&task);
        assert!(!result.is_valid());
        assert!(result.has_errors());

        // Check specific error messages
        let errors = result.errors();
        let has_testing_error = errors.iter().any(|e| {
            e.section_type == SectionType::TestingCriterion
                && e.current_count == 1
                && e.required_count == Some(2)
        });
        assert!(
            has_testing_error,
            "Should have error for insufficient testing_criterion"
        );

        let has_constraint_error = errors.iter().any(|e| {
            e.section_type == SectionType::Constraint
                && e.current_count == 1
                && e.required_count == Some(2)
        });
        assert!(
            has_constraint_error,
            "Should have error for insufficient constraint"
        );
    }

    #[test]
    fn test_validation_issue_clone() {
        let issue = ValidationIssue::missing_required(SectionType::Step, 1, 0);
        let cloned = issue.clone();
        assert_eq!(issue.severity, cloned.severity);
        assert_eq!(issue.current_count, cloned.current_count);
        assert_eq!(issue.message, cloned.message);
    }

    #[test]
    fn test_triage_validation_result_clone() {
        let mut result = TriageValidationResult::new("task123");
        result
            .issues
            .push(ValidationIssue::missing_required(SectionType::Step, 1, 0));
        let cloned = result.clone();
        assert_eq!(result.task_id, cloned.task_id);
        assert_eq!(result.issues.len(), cloned.issues.len());
    }

    #[test]
    fn test_triage_validator_default() {
        let validator = TriageValidator::default();
        assert!(!validator.config.rules.is_empty());
    }

    #[test]
    fn test_section_rule_clone() {
        let rule = SectionRule::required(SectionType::Step, 2).with_description("test");
        let cloned = rule.clone();
        assert_eq!(rule.section_type, cloned.section_type);
        assert_eq!(rule.min_count, cloned.min_count);
        assert_eq!(rule.description, cloned.description);
    }

    #[test]
    fn test_triage_validation_config_clone() {
        let config = TriageValidationConfig::default();
        let cloned = config.clone();
        assert_eq!(config.rules.len(), cloned.rules.len());
    }

    #[test]
    fn test_triage_validator_clone() {
        let validator = TriageValidator::new();
        let cloned = validator.clone();
        assert_eq!(validator.config.rules.len(), cloned.config.rules.len());
    }

    #[test]
    fn test_validation_severity_copy() {
        let severity = ValidationSeverity::Error;
        let copied = severity;
        assert_eq!(severity, copied);
    }

    #[test]
    fn test_required_any_satisfied_by_goal() {
        let validator = TriageValidator::new();
        let task = create_task_with_sections(vec![
            Section::new(SectionType::Goal, "Clear objective"),
            Section::new(SectionType::TestingCriterion, "Test 1"),
            Section::new(SectionType::TestingCriterion, "Test 2"),
            Section::new(SectionType::Step, "Step 1"),
            Section::new(SectionType::Constraint, "Constraint 1"),
            Section::new(SectionType::Constraint, "Constraint 2"),
        ]);

        let result = validator.validate(&task);
        // Should not have error for goal/desired_behavior since goal is present
        let has_goal_error = result.errors().iter().any(|e| {
            e.section_type == SectionType::Goal || e.section_type == SectionType::DesiredBehavior
        });
        assert!(
            !has_goal_error,
            "Should not error when goal is present: {:?}",
            result.issues
        );
    }

    #[test]
    fn test_required_any_satisfied_by_desired_behavior() {
        let validator = TriageValidator::new();
        let task = create_task_with_sections(vec![
            Section::new(SectionType::DesiredBehavior, "Expected behavior"),
            Section::new(SectionType::TestingCriterion, "Test 1"),
            Section::new(SectionType::TestingCriterion, "Test 2"),
            Section::new(SectionType::Step, "Step 1"),
            Section::new(SectionType::Constraint, "Constraint 1"),
            Section::new(SectionType::Constraint, "Constraint 2"),
        ]);

        let result = validator.validate(&task);
        // Should not have error for goal/desired_behavior since desired_behavior is present
        let has_goal_error = result.errors().iter().any(|e| {
            e.section_type == SectionType::Goal || e.section_type == SectionType::DesiredBehavior
        });
        assert!(
            !has_goal_error,
            "Should not error when desired_behavior is present: {:?}",
            result.issues
        );
    }

    #[test]
    fn test_required_any_fails_when_neither_present() {
        let validator = TriageValidator::new();
        let task = create_task_with_sections(vec![
            // No goal or desired_behavior
            Section::new(SectionType::TestingCriterion, "Test 1"),
            Section::new(SectionType::TestingCriterion, "Test 2"),
            Section::new(SectionType::Step, "Step 1"),
            Section::new(SectionType::Constraint, "Constraint 1"),
            Section::new(SectionType::Constraint, "Constraint 2"),
        ]);

        let result = validator.validate(&task);
        assert!(
            result.has_errors(),
            "Should have error when neither goal nor desired_behavior present"
        );

        // Check the error message mentions the OR requirement
        let error_messages: Vec<&str> =
            result.errors().iter().map(|e| e.message.as_str()).collect();
        let has_or_message = error_messages.iter().any(|m| m.contains("OR"));
        assert!(
            has_or_message,
            "Error should mention OR requirement: {:?}",
            error_messages
        );
    }

    #[test]
    fn test_section_rule_required_any() {
        let rule =
            SectionRule::required_any(vec![SectionType::Goal, SectionType::DesiredBehavior], 1);
        assert_eq!(rule.section_type, SectionType::Goal);
        assert_eq!(rule.alternatives, vec![SectionType::DesiredBehavior]);
        assert_eq!(rule.min_count, Some(1));
        assert_eq!(rule.severity, ValidationSeverity::Error);
        assert!(rule.has_alternatives());
        assert_eq!(rule.all_types().len(), 2);
    }

    #[test]
    fn test_validation_issue_missing_required_any() {
        let issue = ValidationIssue::missing_required_any(
            vec![SectionType::Goal, SectionType::DesiredBehavior],
            1,
            0,
        );
        assert_eq!(issue.severity, ValidationSeverity::Error);
        assert_eq!(issue.current_count, 0);
        assert_eq!(issue.required_count, Some(1));
        assert!(
            issue.message.contains("OR"),
            "Message should contain OR: {}",
            issue.message
        );
        assert!(
            issue.message.contains("goal"),
            "Message should contain goal: {}",
            issue.message
        );
        assert!(
            issue.message.contains("desired_behavior"),
            "Message should contain desired_behavior: {}",
            issue.message
        );
    }
}
