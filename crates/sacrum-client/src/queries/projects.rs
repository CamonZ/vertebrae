/// List all projects
pub const LIST_PROJECTS: &str = r#"
    query ListProjects {
        projects {
            id
            name
            slug
            description
        }
    }
"#;

/// Create a new project
pub const CREATE_PROJECT: &str = r#"
    mutation CreateProject($name: String!, $slug: String!) {
        create_project(name: $name, slug: $slug) {
            id
            name
            slug
            description
        }
    }
"#;
