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
    mutation CreateProject(
        $name: String!,
        $slug: String!,
        $codexInstalled: Boolean!,
        $claudeInstalled: Boolean!
    ) {
        createProject(
            name: $name,
            slug: $slug,
            codexInstalled: $codexInstalled,
            claudeInstalled: $claudeInstalled
        ) {
            id
            name
            slug
            description
        }
    }
"#;
