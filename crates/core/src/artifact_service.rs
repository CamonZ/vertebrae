//! Artifact service trait for artifact files and their attachment context.
//!
//! This module defines the transport-independent contract used by the CLI,
//! GUI, and backend clients. Root reads are user-scoped in Sacrum, while
//! attachment-context operations establish a project and subject scope.

use crate::error::ServiceResult;
use crate::models::{
    Artifact, CreateArtifactInput, GetArtifactByLogicalNameInput, ListArtifactInput,
    UpdateArtifactInput,
};
use async_trait::async_trait;

/// Service trait for artifact CRUD operations.
///
/// Implementations apply active-project scope only to operations that accept
/// it. [`Self::get_artifact`] is user-scoped and must not fabricate ownership.
#[async_trait]
pub trait ArtifactService: Send + Sync {
    /// Create an artifact in the active project.
    async fn create_artifact(&self, input: CreateArtifactInput) -> ServiceResult<Artifact>;

    /// List artifacts in the active project using the supplied pagination.
    async fn list_artifacts(&self, input: ListArtifactInput) -> ServiceResult<Vec<Artifact>>;

    /// List artifacts attached to a task in the active project.
    ///
    /// The returned artifact projections include the attachment's logical name
    /// and metadata when Sacrum loads them through `Task.artifacts`.
    async fn list_task_artifacts(&self, task_id: &str) -> ServiceResult<Vec<Artifact>>;

    /// Get an artifact by ID within the caller's user scope.
    async fn get_artifact(&self, id: &str) -> ServiceResult<Artifact>;

    /// Get an attachment by its subject-local logical name in the active project.
    async fn get_artifact_by_logical_name(
        &self,
        input: GetArtifactByLogicalNameInput,
    ) -> ServiceResult<Artifact>;

    /// Update an artifact by ID within the caller's user scope.
    async fn update_artifact(
        &self,
        id: &str,
        input: UpdateArtifactInput,
    ) -> ServiceResult<Artifact>;

    /// Delete an artifact by ID within the active project.
    async fn delete_artifact(&self, id: &str) -> ServiceResult<Artifact>;
}
