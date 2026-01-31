//! ExecutionService implementation for Sacrum HTTP API - Stub
//!
//! Implements the ExecutionService trait by making HTTP calls to the Sacrum REST API.

use async_trait::async_trait;
use vertebrae_core::error::ServiceResult;
use vertebrae_core::execution_service::ExecutionService;
use vertebrae_core::models::{SessionLog, StepExecution};

/// ExecutionService implementation stub for Sacrum HTTP client
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SacrumExecutionService;

impl SacrumExecutionService {
    /// Create a new SacrumExecutionService
    pub fn new() -> Self {
        Self
    }
}

impl Default for SacrumExecutionService {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ExecutionService for SacrumExecutionService {
    async fn create_execution(&self, _execution: StepExecution) -> ServiceResult<String> {
        unimplemented!("Execution creation not yet implemented for Sacrum HTTP client")
    }

    async fn get_execution(&self, _id: &str) -> ServiceResult<Option<StepExecution>> {
        unimplemented!("Execution retrieval not yet implemented for Sacrum HTTP client")
    }

    async fn list_executions_for_task(&self, _task_id: &str) -> ServiceResult<Vec<StepExecution>> {
        unimplemented!("Execution listing not yet implemented for Sacrum HTTP client")
    }

    async fn add_log(&self, _log: SessionLog) -> ServiceResult<String> {
        unimplemented!("Log addition not yet implemented for Sacrum HTTP client")
    }

    async fn list_logs_for_execution(&self, _execution_id: &str) -> ServiceResult<Vec<SessionLog>> {
        unimplemented!("Log listing not yet implemented for Sacrum HTTP client")
    }

    async fn get_latest_execution_for_task(
        &self,
        _task_id: &str,
    ) -> ServiceResult<Option<StepExecution>> {
        unimplemented!("Latest execution retrieval not yet implemented for Sacrum HTTP client")
    }

    async fn update_execution(
        &self,
        _execution_id: &str,
        _output: Option<String>,
        _transition_result: Option<String>,
    ) -> ServiceResult<()> {
        unimplemented!("Execution update not yet implemented for Sacrum HTTP client")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_service_new_creates_service() {
        let service = SacrumExecutionService::new();
        assert_eq!(service, SacrumExecutionService);
    }

    #[test]
    fn test_service_default_creates_service() {
        let service = SacrumExecutionService::default();
        assert_eq!(service, SacrumExecutionService);
    }

    #[test]
    fn test_service_clone() {
        let service = SacrumExecutionService::new();
        let cloned = service.clone();
        assert_eq!(service, cloned);
    }

    #[test]
    fn test_service_debug_representation() {
        let service = SacrumExecutionService::new();
        let debug_str = format!("{:?}", service);
        assert!(debug_str.contains("SacrumExecutionService"));
    }

    #[test]
    fn test_service_equality() {
        let service1 = SacrumExecutionService::new();
        let service2 = SacrumExecutionService::new();
        assert_eq!(service1, service2);
    }

    #[test]
    fn test_multiple_service_instances() {
        let s1 = SacrumExecutionService::new();
        let s2 = SacrumExecutionService::new();
        let s3 = SacrumExecutionService::default();

        assert_eq!(s1, s2);
        assert_eq!(s2, s3);
        assert_eq!(s1, s3);
    }

    #[test]
    fn test_service_clone_independence() {
        let original = SacrumExecutionService::new();
        let clone1 = original.clone();
        let clone2 = clone1.clone();

        assert_eq!(original, clone1);
        assert_eq!(clone1, clone2);
    }
}
