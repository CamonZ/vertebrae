//! GraphQL operations for project-scoped artifacts.

pub const ARTIFACT_FIELDS: &str = r#"
    fragment ArtifactFields on Artifact {
        id
        project_id
        filename
        body
        inserted_at
        updated_at
    }
"#;

pub const GET_ARTIFACT: &str = r#"
    query GetArtifact($id: Uuid4!) {
        artifact(id: $id) { ...ArtifactFields }
    }
"#;

pub const LIST_ARTIFACTS: &str = r#"
    query ListArtifacts($project_id: Uuid4!, $limit: Int, $offset: Int) {
        artifacts(project_id: $project_id, limit: $limit, offset: $offset) { ...ArtifactFields }
    }
"#;

pub const CREATE_ARTIFACT: &str = r#"
    mutation CreateArtifact($project_id: Uuid4!, $filename: String!, $body: String!, $subject_type: String, $subject_id: Uuid4) {
        createArtifact(project_id: $project_id, filename: $filename, body: $body, subject_type: $subject_type, subject_id: $subject_id) { ...ArtifactFields }
    }
"#;

pub const UPDATE_ARTIFACT: &str = r#"
    mutation UpdateArtifact($id: Uuid4!, $filename: String, $body: String) {
        updateArtifact(id: $id, filename: $filename, body: $body) { ...ArtifactFields }
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
        assert!(CREATE_ARTIFACT.contains("mutation CreateArtifact"));
        assert!(CREATE_ARTIFACT.contains("$subject_type: String"));
        assert!(CREATE_ARTIFACT.contains("$subject_id: Uuid4"));
        assert!(UPDATE_ARTIFACT.contains("mutation UpdateArtifact"));
        assert!(DELETE_ARTIFACT.contains("mutation DeleteArtifact"));
    }
}
