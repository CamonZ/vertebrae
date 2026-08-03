//! GraphQL operations for artifacts and their project-subject attachments.

pub const ARTIFACT_FIELDS: &str = r#"
    fragment ArtifactFields on Artifact {
        id
        filename
        body
        logical_name
        metadata
        inserted_at
        updated_at
    }
"#;

pub const GET_ARTIFACT: &str = r#"
    query GetArtifact($id: Uuid4!) {
        artifact(id: $id) { ...ArtifactFields }
    }
"#;

pub const GET_ARTIFACT_BY_LOGICAL_NAME: &str = r#"
    query GetArtifactByLogicalName($project_id: Uuid4!, $subject_type: String!, $subject_id: Uuid4!, $logical_name: String!) {
        artifactByLogicalName(project_id: $project_id, subject_type: $subject_type, subject_id: $subject_id, logical_name: $logical_name) { ...ArtifactFields }
    }
"#;

pub const LIST_ARTIFACTS: &str = r#"
    query ListArtifacts($project_id: Uuid4!, $limit: Int, $offset: Int) {
        project(id: $project_id) {
            artifacts(limit: $limit, offset: $offset) { ...ArtifactFields }
        }
    }
"#;

/// List the artifact projections attached to one task.
///
/// Sacrum already exposes this through the Task association. Keeping this
/// query here lets every client use the same artifact projection rather than
/// adding a logical-name lookup or a separate link enumeration API.
pub const LIST_TASK_ARTIFACTS: &str = r#"
    query ListTaskArtifacts($task_id: Uuid4!, $limit: Int, $offset: Int) {
        task(id: $task_id) {
            artifacts(limit: $limit, offset: $offset) { ...ArtifactFields }
        }
    }
"#;

pub const CREATE_ARTIFACT: &str = r#"
    mutation CreateArtifact($project_id: Uuid4!, $filename: String!, $body: String!, $subject_type: String, $subject_id: Uuid4, $logical_name: String, $metadata: Json) {
        createArtifact(project_id: $project_id, filename: $filename, body: $body, subject_type: $subject_type, subject_id: $subject_id, logical_name: $logical_name, metadata: $metadata) { ...ArtifactFields }
    }
"#;

pub const UPDATE_ARTIFACT: &str = r#"
    mutation UpdateArtifact($id: Uuid4!, $filename: String, $body: String, $subject_type: String, $subject_id: Uuid4, $logical_name: String, $metadata: Json) {
        updateArtifact(id: $id, filename: $filename, body: $body, subject_type: $subject_type, subject_id: $subject_id, logical_name: $logical_name, metadata: $metadata) { ...ArtifactFields }
    }
"#;

pub const DELETE_ARTIFACT: &str = r#"
    mutation DeleteArtifact($id: Uuid4!) {
        deleteArtifact(id: $id) { ...ArtifactFields }
    }
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operations_and_variables_are_project_scoped() {
        assert!(LIST_ARTIFACTS.contains("query ListArtifacts"));
        assert!(LIST_ARTIFACTS.contains("$project_id: Uuid4!"));
        assert!(LIST_TASK_ARTIFACTS.contains("query ListTaskArtifacts"));
        assert!(LIST_TASK_ARTIFACTS.contains("$task_id: Uuid4!"));
        assert!(LIST_TASK_ARTIFACTS.contains("$limit: Int"));
        assert!(LIST_TASK_ARTIFACTS.contains("$offset: Int"));
        assert!(LIST_TASK_ARTIFACTS.contains("task(id: $task_id)"));
        assert!(LIST_TASK_ARTIFACTS.contains("artifacts(limit: $limit, offset: $offset)"));
        assert!(CREATE_ARTIFACT.contains("mutation CreateArtifact"));
        assert!(CREATE_ARTIFACT.contains("$subject_type: String"));
        assert!(CREATE_ARTIFACT.contains("$subject_id: Uuid4"));
        assert!(CREATE_ARTIFACT.contains("$logical_name: String"));
        assert!(CREATE_ARTIFACT.contains("$metadata: Json"));
        assert!(UPDATE_ARTIFACT.contains("mutation UpdateArtifact"));
        assert!(UPDATE_ARTIFACT.contains("$subject_type: String"));
        assert!(UPDATE_ARTIFACT.contains("$metadata: Json"));
        assert!(GET_ARTIFACT_BY_LOGICAL_NAME.contains("artifactByLogicalName"));
        assert!(GET_ARTIFACT_BY_LOGICAL_NAME.contains("$project_id: Uuid4!"));
        assert!(DELETE_ARTIFACT.contains("mutation DeleteArtifact"));
    }
}
