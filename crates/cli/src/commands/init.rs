//! Init command for initializing vertebrae in a project
//!
//! Implements the `vtb init` command to:
//! 1. Read or bootstrap global config at ~/.config/vertebrae/config.toml
//! 2. Accept --token flag for first-time setup (sets [sacrum].token)
//! 3. Accept --url flag for Sacrum API endpoint (default from config or https://vertebrae.dev)
//! 4. Derive project slug from current directory name
//! 5. Check if project exists in Sacrum API, create if needed
//! 6. Register the project in global config
//! 7. Write embedded skills to the configured target directory

use clap::Args;
use serde::Serialize;
use std::path::PathBuf;
use vertebrae_sacrum_client::{
    GraphqlClient, SacrumConfig, config_path, load_config_file, register_project, save_config_file,
};
use vertebrae_skills_assets::{SkillsAssetError, install_embedded_skills};

/// Initialize vertebrae in the current project
#[derive(Debug, Args)]
pub struct InitCommand {
    /// Sacrum API base URL (overrides config file value)
    #[arg(long)]
    pub url: Option<String>,

    /// API token for Sacrum authentication (saved to config file)
    #[arg(long)]
    pub token: Option<String>,

    /// Target directory for skills (defaults to ".claude/skills")
    #[arg(long, default_value = ".claude/skills")]
    pub skills_target: PathBuf,
}

/// Result of the init command execution
#[derive(Debug, Serialize)]
pub struct InitResult {
    /// Path to the config file
    pub config_path: PathBuf,
    /// Project slug in config
    pub project_slug: String,
    /// Project ID in Sacrum
    pub project_id: String,
    /// Project name
    pub project_name: String,
    /// Number of skills copied
    pub skills_copied: usize,
    /// Directory where embedded skills were copied
    pub skills_target: PathBuf,
    /// Whether the project was newly created
    pub project_created: bool,
}

impl std::fmt::Display for InitResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "Vertebrae initialized successfully!")?;
        writeln!(f)?;
        writeln!(f, "  Config file: {}", self.config_path.display())?;
        writeln!(f, "  Project slug: {}", self.project_slug)?;
        writeln!(f, "  Project name: {}", self.project_name)?;
        writeln!(f, "  Project ID: {}", self.project_id)?;

        if self.project_created {
            writeln!(f, "  Created new Sacrum project")?;
        } else {
            writeln!(f, "  Found existing Sacrum project")?;
        }

        if self.skills_copied > 0 {
            write!(
                f,
                "  Copied {} skill(s) to {}",
                self.skills_copied,
                self.skills_target.display()
            )?;
        } else {
            write!(
                f,
                "  No skills to copy (source directory not found or empty)"
            )?;
        }

        Ok(())
    }
}

/// Error type for init command failures
#[derive(Debug)]
pub enum InitError {
    /// Missing API token (not in config and not provided via --token)
    MissingToken(String),
    /// Failed to get current directory
    CurrentDir { reason: String },
    /// Failed to derive project slug
    SlugDerive { reason: String },
    /// Failed to communicate with Sacrum API
    SacrumApi { reason: String },
    /// Failed to create directory
    CreateDir { path: PathBuf, reason: String },
    /// Failed to copy file
    CopyFile {
        source: PathBuf,
        target: PathBuf,
        reason: String,
    },
    /// Failed to write config file
    WriteConfig { path: PathBuf, reason: String },
    /// Config error
    ConfigError { reason: String },
}

impl std::fmt::Display for InitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InitError::MissingToken(reason) => write!(f, "{}", reason),
            InitError::CurrentDir { reason } => {
                write!(f, "Failed to get current directory: {}", reason)
            }
            InitError::SlugDerive { reason } => {
                write!(f, "Failed to derive project slug: {}", reason)
            }
            InitError::SacrumApi { reason } => {
                write!(f, "Failed to communicate with Sacrum API: {}", reason)
            }
            InitError::CreateDir { path, reason } => {
                write!(
                    f,
                    "Failed to create directory '{}': {}",
                    path.display(),
                    reason
                )
            }
            InitError::CopyFile {
                source,
                target,
                reason,
            } => {
                write!(
                    f,
                    "Failed to copy '{}' to '{}': {}",
                    source.display(),
                    target.display(),
                    reason
                )
            }
            InitError::WriteConfig { path, reason } => {
                write!(
                    f,
                    "Failed to write config file '{}': {}",
                    path.display(),
                    reason
                )
            }
            InitError::ConfigError { reason } => {
                write!(f, "Config error: {}", reason)
            }
        }
    }
}

impl std::error::Error for InitError {}

impl From<SkillsAssetError> for InitError {
    fn from(error: SkillsAssetError) -> Self {
        match error {
            SkillsAssetError::CreateDir { path, reason } => InitError::CreateDir { path, reason },
            SkillsAssetError::WriteFile {
                relative_path,
                target,
                reason,
            } => InitError::CopyFile {
                source: relative_path,
                target,
                reason,
            },
        }
    }
}

impl InitCommand {
    /// Execute the init command.
    ///
    /// 1. Loads or bootstraps global config
    /// 2. Resolves API token (from --token flag or existing config)
    /// 3. Gets current directory
    /// 4. Derives project slug from folder name
    /// 5. Checks if project exists in Sacrum, creates if not
    /// 6. Registers project in global config
    /// 7. Copies skills from source to target directory
    pub async fn execute(&self) -> Result<InitResult, InitError> {
        // Load existing global config (or default if none exists)
        let mut config_file = load_config_file().map_err(|e| InitError::ConfigError {
            reason: e.to_string(),
        })?;

        // Resolve API token: --token flag takes precedence, then existing config
        let api_token = if let Some(ref token) = self.token {
            // Update config with the provided token
            config_file.sacrum.token = Some(token.clone());
            token.clone()
        } else {
            config_file.sacrum.token.clone().ok_or_else(|| {
                InitError::MissingToken(
                    "No API token found.\n\
                     Hint: Run `vtb init --token <your_token>` to set up authentication,\n\
                     or add [sacrum].token to ~/.config/vertebrae/config.toml"
                        .to_string(),
                )
            })?
        };

        // Update URL if provided via --url flag
        if let Some(ref url) = self.url {
            config_file.sacrum.url = url.clone();
        }

        let base_url = config_file.sacrum.url.clone();

        // Save config if --token or --url were provided (bootstrap the [sacrum] section)
        if self.token.is_some() || self.url.is_some() {
            save_config_file(&config_file).map_err(|e| InitError::WriteConfig {
                path: config_path().unwrap_or_default(),
                reason: e.to_string(),
            })?;
        }

        // Get current directory
        let current_dir = std::env::current_dir().map_err(|e| InitError::CurrentDir {
            reason: e.to_string(),
        })?;

        // Derive project slug from current directory name
        let folder_name = current_dir
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| InitError::SlugDerive {
                reason: "Failed to extract folder name".to_string(),
            })?
            .to_string();

        let project_slug = self.derive_slug(&folder_name)?;

        // Create Sacrum client and check/create project
        let config = SacrumConfig::new(base_url, api_token, "temp".to_string());
        let client = GraphqlClient::new(config);

        let (project, created) = self
            .get_or_create_project(&client, &folder_name, &project_slug)
            .await?;

        // Register project in global config
        let project_path = current_dir
            .canonicalize()
            .unwrap_or(current_dir.clone())
            .to_string_lossy()
            .to_string();

        register_project(&project_slug, &project.id, &project_path).map_err(|e| {
            InitError::WriteConfig {
                path: config_path().unwrap_or_default(),
                reason: e.to_string(),
            }
        })?;

        // Copy skills
        let skills_target = current_dir.join(&self.skills_target);
        let skills_copied = install_embedded_skills(&skills_target).map_err(InitError::from)?;

        Ok(InitResult {
            config_path: config_path().unwrap_or_default(),
            project_slug,
            project_id: project.id,
            project_name: project.name,
            skills_copied,
            skills_target,
            project_created: created,
        })
    }

    /// Derive a URL-friendly slug from a folder name
    /// Converts to lowercase, replaces spaces and special chars with hyphens
    fn derive_slug(&self, name: &str) -> Result<String, InitError> {
        let slug = slug::slugify(name);
        if slug.is_empty() {
            return Err(InitError::SlugDerive {
                reason: format!("Could not create valid slug from: {}", name),
            });
        }
        Ok(slug)
    }

    /// Get existing project or create a new one
    async fn get_or_create_project(
        &self,
        client: &GraphqlClient,
        name: &str,
        slug: &str,
    ) -> Result<(vertebrae_sacrum_client::ProjectResponse, bool), InitError> {
        use vertebrae_sacrum_client::queries::projects;

        // Try to find existing project by slug
        match client
            .execute::<Vec<vertebrae_sacrum_client::ProjectResponse>>(
                projects::LIST_PROJECTS,
                serde_json::json!({}),
                "projects",
            )
            .await
        {
            Ok(projects) => {
                if let Some(project) = projects.iter().find(|p| p.slug == slug) {
                    return Ok((project.clone(), false));
                }
            }
            Err(e) => {
                return Err(InitError::SacrumApi {
                    reason: format!("Failed to list projects: {}", e),
                });
            }
        }

        // Project not found, create it
        match client
            .execute::<vertebrae_sacrum_client::ProjectResponse>(
                projects::CREATE_PROJECT,
                serde_json::json!({
                    "name": name,
                    "slug": slug,
                }),
                "create_project",
            )
            .await
        {
            Ok(project) => Ok((project, true)),
            Err(e) => Err(InitError::SacrumApi {
                reason: format!("Failed to create project: {}", e),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use std::io::ErrorKind;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::Path;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    use vertebrae_skills_assets::{install_embedded_skills, list_embedded_skills};

    const CURATED_SKILL_COUNT: usize = 26;

    /// Helper to create a temporary test directory
    fn create_temp_dir(prefix: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "vtb-init-test-{}-{}-{:?}-{}",
            prefix,
            std::process::id(),
            std::thread::current().id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// Clean up test directory
    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    struct EnvGuard {
        previous_home: Option<std::ffi::OsString>,
        previous_xdg_config_home: Option<std::ffi::OsString>,
        previous_cwd: PathBuf,
    }

    impl EnvGuard {
        fn new(home: &Path, cwd: &Path) -> Self {
            let previous_home = env::var_os("HOME");
            let previous_xdg_config_home = env::var_os("XDG_CONFIG_HOME");
            let previous_cwd = env::current_dir().expect("current dir");
            // SAFETY: this guard is only used in serial tests because process
            // environment and current directory are global mutable state.
            unsafe { env::set_var("HOME", home) };
            unsafe { env::set_var("XDG_CONFIG_HOME", home.join(".config")) };
            env::set_current_dir(cwd).expect("set current dir");

            Self {
                previous_home,
                previous_xdg_config_home,
                previous_cwd,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            let _ = env::set_current_dir(&self.previous_cwd);
            match &self.previous_home {
                Some(home) => unsafe { env::set_var("HOME", home) },
                None => unsafe { env::remove_var("HOME") },
            }
            match &self.previous_xdg_config_home {
                Some(config_home) => unsafe { env::set_var("XDG_CONFIG_HOME", config_home) },
                None => unsafe { env::remove_var("XDG_CONFIG_HOME") },
            }
        }
    }

    struct MockSacrumServer {
        url: String,
        shutdown_tx: mpsc::Sender<()>,
        handle: thread::JoinHandle<()>,
    }

    impl MockSacrumServer {
        fn stop(&self) {
            let _ = self.shutdown_tx.send(());
        }

        fn join(self) {
            self.handle
                .join()
                .expect("mock Sacrum server thread panicked");
        }
    }

    fn start_mock_sacrum_server() -> MockSacrumServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        listener
            .set_nonblocking(true)
            .expect("configure mock server listener");
        let url = format!("http://{}", listener.local_addr().expect("local addr"));
        let (shutdown_tx, shutdown_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            let mut handled_requests = 0;

            while handled_requests < 2 {
                if shutdown_rx.try_recv().is_ok() {
                    break;
                }

                let (mut stream, _) = match listener.accept() {
                    Ok(accepted) => accepted,
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("accept mock request: {error}"),
                };
                stream
                    .set_nonblocking(false)
                    .expect("configure mock request stream");

                let request = read_http_request(&mut stream);
                let body = if handled_requests == 0 {
                    assert!(
                        request.contains("ListProjects"),
                        "first init request should list projects, got {request}"
                    );
                    r#"{"data":{"projects":[]}}"#.to_string()
                } else {
                    assert!(
                        request.contains("CreateProject"),
                        "second init request should create project, got {request}"
                    );
                    r#"{"data":{"create_project":{"id":"proj-123","name":"Temp Project","slug":"temp-project","description":null}}}"#
                        .to_string()
                };
                handled_requests += 1;

                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write mock response");
            }
        });

        MockSacrumServer {
            url,
            shutdown_tx,
            handle,
        }
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0; 1024];

        loop {
            let bytes_read = stream.read(&mut buffer).expect("read mock request");
            if bytes_read == 0 {
                break;
            }

            request.extend_from_slice(&buffer[..bytes_read]);

            if let Some(header_end) = find_header_end(&request) {
                let content_length = content_length(&request[..header_end]).unwrap_or(0);
                let body_start = header_end + 4;
                if request.len() >= body_start + content_length {
                    break;
                }
            }
        }

        String::from_utf8(request).expect("mock request is utf8")
    }

    fn find_header_end(request: &[u8]) -> Option<usize> {
        request.windows(4).position(|window| window == b"\r\n\r\n")
    }

    fn content_length(headers: &[u8]) -> Option<usize> {
        let headers = String::from_utf8_lossy(headers);
        headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())
                .flatten()
        })
    }

    fn default_cmd() -> InitCommand {
        InitCommand {
            url: None,
            token: None,
            skills_target: PathBuf::from(".claude/skills"),
        }
    }

    #[test]
    fn test_derive_slug_lowercase() {
        let cmd = default_cmd();
        let slug = cmd.derive_slug("My Project").unwrap();
        assert_eq!(slug, "my-project");
    }

    #[test]
    fn test_derive_slug_with_spaces() {
        let cmd = default_cmd();
        let slug = cmd.derive_slug("Project With Spaces").unwrap();
        assert_eq!(slug, "project-with-spaces");
    }

    #[test]
    fn test_derive_slug_with_special_chars() {
        let cmd = default_cmd();
        let slug = cmd.derive_slug("My-Project_123").unwrap();
        // slug crate will handle the conversion
        assert!(!slug.is_empty());
    }

    #[test]
    fn test_derive_slug_empty() {
        let cmd = default_cmd();
        let result = cmd.derive_slug("@#$%");
        assert!(result.is_err());
    }

    #[test]
    fn test_vtb_init_skill_install_step_installs_curated_skills() {
        let temp_dir = create_temp_dir("copy");
        fs::create_dir_all(&temp_dir).unwrap();

        let skills_target = temp_dir.join(".claude/skills");

        let count = install_embedded_skills(&skills_target).unwrap();

        assert_eq!(count, CURATED_SKILL_COUNT);
        assert_eq!(list_embedded_skills().len(), CURATED_SKILL_COUNT);
        assert!(skills_target.join("vtb-add/SKILL.md").exists());
        assert!(!skills_target.join("vtb-gui-dev").exists());
        assert!(!skills_target.join("vtb-execution").exists());

        cleanup(&temp_dir);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn test_vtb_init_in_temp_dir_installs_exact_curated_skills() {
        let home_dir = create_temp_dir("home");
        let project_dir = create_temp_dir("Temp Project");
        fs::create_dir_all(&home_dir).unwrap();
        fs::create_dir_all(&project_dir).unwrap();

        {
            let _env = EnvGuard::new(&home_dir, &project_dir);
            let current_project_dir = env::current_dir().expect("current project dir");
            let server = start_mock_sacrum_server();
            let cmd = InitCommand {
                url: Some(server.url.clone()),
                token: Some("test-token".to_string()),
                skills_target: PathBuf::from(".claude/skills"),
            };

            let init_result = cmd.execute().await;
            if init_result.is_err() {
                server.stop();
            }
            server.join();
            let result = init_result.expect("init succeeds");

            assert_eq!(result.skills_copied, CURATED_SKILL_COUNT);
            assert_eq!(
                result.skills_target,
                current_project_dir.join(".claude/skills")
            );
            assert!(result.project_created);

            let target = current_project_dir.join(".claude/skills");
            let mut installed = fs::read_dir(&target)
                .expect("read installed skills")
                .map(|entry| {
                    entry
                        .expect("read entry")
                        .file_name()
                        .into_string()
                        .expect("skill name utf8")
                })
                .collect::<Vec<_>>();
            installed.sort_unstable();

            let expected = list_embedded_skills();
            assert_eq!(installed, expected);
            assert!(!target.join("vtb-gui-dev").exists());
            assert!(!target.join("vtb-execution").exists());
        }

        cleanup(&home_dir);
        cleanup(&project_dir);
    }

    #[test]
    fn test_init_writes_skill_content() {
        let temp_dir = create_temp_dir("content");
        fs::create_dir_all(&temp_dir).unwrap();

        let skills_target = temp_dir.join(".claude/skills");

        let result = install_embedded_skills(&skills_target);
        assert!(result.is_ok());

        // Verify that written files have content
        if skills_target.join("add/SKILL.md").exists() {
            let content = fs::read_to_string(skills_target.join("add/SKILL.md")).unwrap();
            assert!(!content.is_empty(), "Skill file should have content");
        }

        cleanup(&temp_dir);
    }

    #[test]
    fn test_init_result_display() {
        let result = InitResult {
            config_path: PathBuf::from("/home/user/.config/vertebrae/config.toml"),
            project_slug: "my-project".to_string(),
            project_id: "proj-123".to_string(),
            project_name: "My Project".to_string(),
            skills_copied: 5,
            skills_target: PathBuf::from("/tmp/my-project/.custom/skills"),
            project_created: true,
        };

        let output = format!("{}", result);
        assert!(output.contains("Vertebrae initialized successfully"));
        assert!(output.contains("config.toml"));
        assert!(output.contains("my-project"));
        assert!(output.contains("proj-123"));
        assert!(output.contains("My Project"));
        assert!(output.contains("Copied 5 skill(s)"));
        assert!(output.contains("/tmp/my-project/.custom/skills"));
    }

    #[test]
    fn test_init_result_display_existing_project() {
        let result = InitResult {
            config_path: PathBuf::from("/home/user/.config/vertebrae/config.toml"),
            project_slug: "vertebrae".to_string(),
            project_id: "proj-456".to_string(),
            project_name: "Vertebrae".to_string(),
            skills_copied: 0,
            skills_target: PathBuf::from(".claude/skills"),
            project_created: false,
        };

        let output = format!("{}", result);
        assert!(output.contains("Found existing Sacrum project"));
        assert!(output.contains("No skills to copy"));
    }

    #[test]
    fn test_init_error_missing_token() {
        let err = InitError::MissingToken("test error".to_string());
        let output = format!("{}", err);
        assert!(output.contains("test error"));
    }

    #[test]
    fn test_init_error_current_dir() {
        let err = InitError::CurrentDir {
            reason: "Permission denied".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("Failed to get current directory"));
        assert!(output.contains("Permission denied"));
    }

    #[test]
    fn test_init_error_sacrum_api() {
        let err = InitError::SacrumApi {
            reason: "Connection failed".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("Failed to communicate with Sacrum API"));
        assert!(output.contains("Connection failed"));
    }

    #[test]
    fn test_init_error_config_error() {
        let err = InitError::ConfigError {
            reason: "Could not serialize config".to_string(),
        };
        let output = format!("{}", err);
        assert!(output.contains("Config error"));
    }

    #[test]
    fn test_init_command_debug() {
        let cmd = default_cmd();
        let debug_str = format!("{:?}", cmd);
        assert!(debug_str.contains("InitCommand"));
    }
}
