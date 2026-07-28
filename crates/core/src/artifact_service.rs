//! Artifact service trait for project-scoped artifact management.
//!
//! This module defines the transport-independent contract used by the CLI,
//! GUI, and backend clients. Attachment and link operations intentionally stay
//! outside this contract.

use crate::error::ServiceResult;
use crate::models::{Artifact, CreateArtifactInput, ListArtifactInput, UpdateArtifactInput};
use async_trait::async_trait;

/// Service trait for artifact CRUD operations.
///
/// Implementations are responsible for applying the active project scope and
/// translating backend-specific failures into [`crate::ServiceError`].
#[async_trait]
pub trait ArtifactService: Send + Sync {
    /// Create an artifact in the active project.
    async fn create_artifact(&self, input: CreateArtifactInput) -> ServiceResult<Artifact>;

    /// List artifacts in the active project using the supplied pagination.
    async fn list_artifacts(&self, input: ListArtifactInput) -> ServiceResult<Vec<Artifact>>;

    /// Get an artifact by ID within the active project.
    async fn get_artifact(&self, id: &str) -> ServiceResult<Artifact>;

    /// Update an artifact by ID within the active project.
    async fn update_artifact(
        &self,
        id: &str,
        input: UpdateArtifactInput,
    ) -> ServiceResult<Artifact>;

    /// Delete an artifact by ID within the active project.
    async fn delete_artifact(&self, id: &str) -> ServiceResult<Artifact>;
}
