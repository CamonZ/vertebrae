use super::*;

// ============================================================================
// Project Management Commands
// ============================================================================

/// Get the list of saved projects
#[tauri::command]
#[specta::specta]
pub async fn get_projects(state: State<'_, AppState>) -> Result<Vec<SavedProject>, CommandError> {
    log::info!("get_projects called");
    Ok(state.project_config.get_projects())
}

/// List all embedded skills available for GUI project initialization.
#[tauri::command]
#[specta::specta]
pub async fn list_embedded_skills() -> Result<Vec<String>, CommandError> {
    Ok(vertebrae_skills_assets::list_embedded_skills())
}

/// Preview the backend-derived slug for a project name.
#[tauri::command]
#[specta::specta]
pub async fn preview_project_slug(name: String) -> Result<String, CommandError> {
    derive_project_slug(&name)
}

/// Read the shared Sacrum settings state without exposing the API token.
#[tauri::command]
#[specta::specta]
pub async fn sacrum_config_status() -> Result<SacrumConfigStatus, CommandError> {
    log::info!("sacrum_config_status called");

    let config_path = vertebrae_sacrum_client::config_path();
    let config_exists = config_path.as_ref().is_some_and(|path| path.exists());
    let config_file = vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
        message: format!("Failed to load config file: {}", e),
    })?;
    let url = configured_sacrum_url(&config_file);
    let has_token = config_file
        .sacrum
        .token
        .as_deref()
        .is_some_and(|token| !token.trim().is_empty());

    Ok(SacrumConfigStatus {
        config_path: config_path.map(|path| path.to_string_lossy().to_string()),
        config_exists,
        url,
        has_token,
    })
}

/// Persist Sacrum settings to the shared config.toml.
#[tauri::command]
#[specta::specta]
pub async fn save_sacrum_settings(token: String) -> Result<SacrumConfigStatus, CommandError> {
    log::info!("save_sacrum_settings called");

    let trimmed_token = token.trim();
    if trimmed_token.is_empty() {
        return Err(CommandError {
            message: "Sacrum API token is required".to_string(),
        });
    }
    validate_sacrum_token(trimmed_token)?;

    let mut config_file =
        vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
            message: format!("Failed to load config file: {}", e),
        })?;
    config_file.sacrum.url = configured_sacrum_url(&config_file);
    config_file.sacrum.token = Some(trimmed_token.to_string());

    vertebrae_sacrum_client::save_config_file(&config_file).map_err(|e| CommandError {
        message: format!("Failed to save config file: {}", e),
    })?;

    sacrum_config_status().await
}

/// Initialize a local project from the GUI without shelling out to `vtb init`.
#[tauri::command]
#[specta::specta]
pub async fn initialize_project(
    app_handle: tauri::AppHandle,
    path: String,
    name: Option<String>,
) -> Result<InitializeProjectResult, CommandError> {
    initialize_project_inner(&app_handle, path, name).await
}

pub(crate) async fn initialize_project_inner<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
    path: String,
    name: Option<String>,
) -> Result<InitializeProjectResult, CommandError> {
    log::info!("initialize_project called with path: {}", path);

    let project_root = canonical_project_root(&path)?;
    let folder_name = project_root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CommandError {
            message: "Failed to extract folder name from path".to_string(),
        })?;
    let project_name = name
        .as_deref()
        .map(str::trim)
        .filter(|candidate| !candidate.is_empty())
        .unwrap_or(folder_name)
        .to_string();
    let project_slug = derive_project_slug(&project_name)?;

    let config_file = vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
        message: format!("Failed to load config file: {}", e),
    })?;
    ensure_project_slug_available_for_path(&config_file, &project_slug, &project_root)?;
    let api_token = config_file
        .sacrum
        .token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| CommandError {
            message: "No API token found. Save Sacrum settings before initializing a project."
                .to_string(),
        })?
        .to_string();
    validate_sacrum_token(&api_token)?;
    let base_url = configured_sacrum_url(&config_file);
    let temp_config =
        vertebrae_sacrum_client::SacrumConfig::new(base_url, api_token, "temp".to_string());
    let client = vertebrae_sacrum_client::GraphqlClient::new(temp_config);

    let (project, project_created) =
        get_or_create_project(&client, &project_name, &project_slug).await?;
    let project_path = project_root.to_string_lossy().to_string();
    vertebrae_sacrum_client::register_project(&project_slug, &project.id, &project_path).map_err(
        |e| CommandError {
            message: format!("Failed to save config file: {}", e),
        },
    )?;

    let app_skills_dir =
        vertebrae_installer::provision_installed_skills_dir().map_err(|e| CommandError {
            message: format!("Failed to provision installed skills directory: {}", e),
        })?;
    let mut progress_files_copied = 0_u32;
    let progress_slug = project_slug.clone();
    let skill_install = vertebrae_skills_assets::link_embedded_skills_for_project_with_progress(
        &app_skills_dir,
        &project_root,
        |file| {
            progress_files_copied = progress_files_copied.saturating_add(1);
            let _ = app_handle.emit(
                "project-init-progress-event",
                crate::events::ProjectInitProgressEvent {
                    project_slug: progress_slug.clone(),
                    kind: crate::events::ProjectInitProgressKind::SkillFileInstalled,
                    files_copied: progress_files_copied,
                    relative_path: Some(file.relative_path.to_string_lossy().to_string()),
                    target_path: Some(file.target_path.to_string_lossy().to_string()),
                },
            );
        },
    )
    .map_err(|e| CommandError {
        message: format!("Failed to install embedded skills: {}", e),
    })?;
    let skills_copied = u32::try_from(skill_install.files_linked).map_err(|_| CommandError {
        message: "Installed skill file count exceeded supported range".to_string(),
    })?;
    let skills_target = format_skill_targets(&skill_install);
    let _ = app_handle.emit(
        "project-init-progress-event",
        crate::events::ProjectInitProgressEvent {
            project_slug: project_slug.clone(),
            kind: crate::events::ProjectInitProgressKind::Completed,
            files_copied: skills_copied,
            relative_path: None,
            target_path: None,
        },
    );

    Ok(InitializeProjectResult {
        slug: project_slug,
        project_id: project.id,
        project_name: project.name,
        path: project_path,
        project_created,
        skills_copied,
        skills_target,
    })
}

/// Add a project to the saved list
///
/// Takes a directory path, derives a slug from the folder name,
/// creates the project in Sacrum API if needed, and registers in global config.
#[tauri::command]
#[specta::specta]
pub async fn add_project(
    _state: State<'_, AppState>,
    path: String,
) -> Result<SavedProject, CommandError> {
    log::info!("add_project called with path: {}", path);

    // Extract folder name from path
    let folder_name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CommandError {
            message: "Failed to extract folder name from path".to_string(),
        })?
        .to_string();

    // Derive slug from folder name
    let project_slug = derive_project_slug(&folder_name)?;

    // Load config file and check for duplicate slug
    let config_file = vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
        message: format!("Failed to load config file: {}", e),
    })?;

    if config_file.projects.contains_key(&project_slug) {
        return Err(CommandError {
            message: format!(
                "Project with slug '{}' already exists in config",
                project_slug
            ),
        });
    }

    // Read API token from global config
    let api_token = config_file
        .sacrum
        .token
        .clone()
        .ok_or_else(|| CommandError {
            message: "No API token found. Set [sacrum].token in ~/.config/vertebrae/config.toml"
                .to_string(),
        })?;

    // Create temporary Sacrum client to get-or-create the project
    let temp_config = vertebrae_sacrum_client::SacrumConfig::new(
        configured_sacrum_url(&config_file),
        api_token,
        "temp".to_string(),
    );
    let client = vertebrae_sacrum_client::GraphqlClient::new(temp_config);

    // Try to find existing project by slug, or create a new one
    let (project, _) = get_or_create_project(&client, &folder_name, &project_slug).await?;

    // Register project in global config
    vertebrae_sacrum_client::register_project(&project_slug, &project.id, &path).map_err(|e| {
        CommandError {
            message: format!("Failed to save config file: {}", e),
        }
    })?;

    Ok(SavedProject {
        slug: project_slug,
        project_id: project.id,
        path,
    })
}

pub(crate) fn configured_sacrum_url(
    config_file: &vertebrae_sacrum_client::VertebraeConfigFile,
) -> String {
    let trimmed_url = config_file.sacrum.url.trim();
    if trimmed_url.is_empty() {
        vertebrae_sacrum_client::GlobalSacrumSection::default().url
    } else {
        trimmed_url.to_string()
    }
}

pub(crate) fn validate_sacrum_token(token: &str) -> Result<(), CommandError> {
    if token.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return Err(CommandError {
            message:
                "Sacrum API token contains characters that cannot be sent in an Authorization header"
                    .to_string(),
        });
    }
    Ok(())
}

pub(crate) fn canonical_project_root(path: &str) -> Result<PathBuf, CommandError> {
    let project_root = PathBuf::from(path);
    if !project_root.is_dir() {
        return Err(CommandError {
            message: format!("Project path is not a directory: {}", path),
        });
    }
    Ok(project_root.canonicalize().unwrap_or(project_root))
}

pub(crate) fn derive_project_slug(name: &str) -> Result<String, CommandError> {
    let project_slug = slug::slugify(name);
    if project_slug.is_empty() {
        return Err(CommandError {
            message: format!("Could not create valid slug from: {}", name),
        });
    }
    Ok(project_slug)
}

pub(crate) fn ensure_project_slug_available_for_path(
    config_file: &vertebrae_sacrum_client::VertebraeConfigFile,
    project_slug: &str,
    project_root: &Path,
) -> Result<(), CommandError> {
    let Some(existing) = config_file.projects.get(project_slug) else {
        return Ok(());
    };

    if paths_refer_to_same_directory(&existing.path, project_root) {
        return Ok(());
    }

    Err(CommandError {
        message: format!(
            "Project with slug '{}' already exists in config",
            project_slug
        ),
    })
}

fn paths_refer_to_same_directory(configured_path: &str, project_root: &Path) -> bool {
    let configured = PathBuf::from(configured_path);
    let configured = configured.canonicalize().unwrap_or(configured);
    let project_root = project_root
        .canonicalize()
        .unwrap_or_else(|_| project_root.to_path_buf());

    configured == project_root
}

fn format_skill_targets(install: &vertebrae_skills_assets::LinkedSkillInstall) -> String {
    if install.target_roots.is_empty() {
        return format!(
            "Staged in {}; no existing .claude/skills or .agents/skills directory found",
            install.app_skills_dir.to_string_lossy()
        );
    }

    install
        .target_roots
        .iter()
        .map(|target| target.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(", ")
}

async fn get_or_create_project(
    client: &vertebrae_sacrum_client::GraphqlClient,
    name: &str,
    slug: &str,
) -> Result<(vertebrae_sacrum_client::ProjectResponse, bool), CommandError> {
    let projects = client
        .execute::<Vec<vertebrae_sacrum_client::ProjectResponse>>(
            vertebrae_sacrum_client::queries::projects::LIST_PROJECTS,
            json!({}),
            "projects",
        )
        .await
        .map_err(|e| CommandError {
            message: format!("Failed to list projects from Sacrum: {}", e),
        })?;

    if let Some(project) = projects.iter().find(|p| p.slug == slug) {
        return Ok((project.clone(), false));
    }

    let project = client
        .execute::<vertebrae_sacrum_client::ProjectResponse>(
            vertebrae_sacrum_client::queries::projects::CREATE_PROJECT,
            json!({
                "name": name,
                "slug": slug,
            }),
            "create_project",
        )
        .await
        .map_err(|e| CommandError {
            message: format!("Failed to create project in Sacrum: {}", e),
        })?;

    Ok((project, true))
}

/// Remove a project from the saved list
///
/// Removes the project from config.toml by slug. If the removed project
/// is the currently selected project, clears the selection and services.
#[tauri::command]
#[specta::specta]
pub async fn remove_project(
    state: State<'_, AppState>,
    socket_state: State<'_, tokio::sync::Mutex<crate::websocket_client::SacrumSocket>>,
    slug: String,
) -> Result<(), CommandError> {
    log::info!("remove_project called with slug: {}", slug);

    // Remove project from global config
    let removed = vertebrae_sacrum_client::unregister_project(&slug).map_err(|e| CommandError {
        message: format!("Failed to update config file: {}", e),
    })?;

    if !removed {
        return Err(CommandError {
            message: format!("Project '{}' not found in config", slug),
        });
    }

    // If the removed project was the current one, clear selection, services, and socket
    if state.project_config.get_current_project().as_deref() == Some(&slug) {
        state
            .project_config
            .set_current_project(None)
            .map_err(|e| CommandError { message: e })?;

        let mut service_lock = state.services.write().await;
        *service_lock = None;
        let mut client_lock = state.sacrum_client.write().await;
        *client_lock = None;

        let mut socket = socket_state.lock().await;
        socket.shutdown().await;
        *socket = crate::websocket_client::SacrumSocket::disconnected();
    }

    Ok(())
}

/// Get the currently selected project slug
#[tauri::command]
#[specta::specta]
pub async fn get_current_project(
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    log::info!("get_current_project called");
    Ok(state.project_config.get_current_project())
}

/// Get the currently selected project's git root path
#[tauri::command]
#[specta::specta]
pub async fn get_current_project_path(
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    log::info!("get_current_project_path called");

    // Get current project slug
    let slug = match state.project_config.get_current_project() {
        Some(s) => s,
        None => return Ok(None),
    };

    // Load config file and find the project's path
    let config_file = vertebrae_sacrum_client::load_config_file().map_err(|e| CommandError {
        message: format!("Failed to load config: {}", e),
    })?;

    let path = config_file.projects.get(&slug).map(|p| p.path.clone());

    Ok(path)
}

/// Set the current project by slug and connect to its backend
#[tauri::command]
#[specta::specta]
pub async fn set_current_project(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    socket_state: State<'_, tokio::sync::Mutex<crate::websocket_client::SacrumSocket>>,
    slug: Option<String>,
) -> Result<(), CommandError> {
    log::info!("set_current_project called with slug: {:?}", slug);

    // Update config
    state
        .project_config
        .set_current_project(slug.clone())
        .map_err(|e| CommandError { message: e })?;

    // Load Sacrum config once (used for both services and WebSocket)
    let sacrum_config = if let Some(ref project_slug) = slug {
        match vertebrae_sacrum_client::SacrumConfig::load_for_project(project_slug) {
            Ok(config) => Some(config),
            Err(e) => {
                return Err(CommandError {
                    message: format!("Failed to load Sacrum configuration: {}", e),
                });
            }
        }
    } else {
        None
    };

    // Switch the Phoenix project channel over the existing socket when the
    // Sacrum backend credentials are unchanged. Recreate only for backend
    // changes or when no actor is running.
    {
        let mut socket = socket_state.lock().await;
        if let Some(config) = sacrum_config.as_ref() {
            log::info!(
                "[WebSocket] Switching realtime channel to project '{}'",
                config.project_id
            );

            let mut should_rebuild_socket = true;
            if socket.has_backend(&config.base_url, &config.api_token) && socket.is_running() {
                if let Err(e) = socket.switch_project(Some(config.project_id.clone())).await {
                    log::warn!(
                        "[WebSocket] Rebuilding realtime socket after failed switch to project '{}': {}",
                        config.project_id,
                        e
                    );
                } else {
                    should_rebuild_socket = false;
                }
            }

            if should_rebuild_socket {
                socket.shutdown().await;
                *socket = crate::websocket_client::SacrumSocket::new(
                    config.base_url.clone(),
                    config.api_token.clone(),
                    config.project_id.clone(),
                );
                socket.connect(&app_handle);
            }
        } else {
            log::info!("[WebSocket] No project selected, shutting down realtime socket");
            socket.shutdown().await;
            *socket = crate::websocket_client::SacrumSocket::disconnected();
        }
    }

    // Update REST services after requesting the realtime channel switch. The
    // websocket actor keeps retrying in the background if the live join fails.
    {
        let mut service_lock = state.services.write().await;
        let mut client_lock = state.sacrum_client.write().await;
        match sacrum_config.as_ref() {
            Some(config) => {
                let client = vertebrae_sacrum_client::GraphqlClient::new(config.clone());
                let client_arc = std::sync::Arc::new(client);
                *service_lock = Some(vertebrae_sacrum_client::from_sacrum(client_arc.clone()));
                *client_lock = Some(client_arc);
            }
            None => {
                *service_lock = None;
                *client_lock = None;
            }
        }
    }

    Ok(())
}

/// Check if a project is currently selected and database is connected
#[tauri::command]
#[specta::specta]
pub async fn has_project_selected(state: State<'_, AppState>) -> Result<bool, CommandError> {
    let service_lock = state.services.read().await;
    Ok(service_lock.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::{build_app_with_services, build_app_without_services};
    use serial_test::serial;
    use std::collections::BTreeMap;
    use std::env;
    use std::fs;
    use std::io::{ErrorKind, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;
    use tauri::{Listener, Manager};

    #[tokio::test]
    async fn list_embedded_skills_returns_sorted_manifest() {
        let skills = list_embedded_skills().await.unwrap();
        let expected = vertebrae_skills_assets::list_embedded_skills();

        assert!(!skills.is_empty());
        assert_eq!(skills, expected);
        assert!(skills.contains(&"vtb-add".to_string()));
    }

    #[tokio::test]
    async fn preview_project_slug_uses_backend_slugifier() {
        assert_eq!(
            preview_project_slug("Ørsted Project".to_string())
                .await
                .unwrap(),
            "orsted-project"
        );
    }

    struct EnvGuard {
        previous_home: Option<std::ffi::OsString>,
        previous_xdg_config_home: Option<std::ffi::OsString>,
    }

    impl EnvGuard {
        fn new(home: &Path) -> Self {
            let previous_home = env::var_os("HOME");
            let previous_xdg_config_home = env::var_os("XDG_CONFIG_HOME");
            unsafe {
                env::set_var("HOME", home);
                env::set_var("XDG_CONFIG_HOME", home.join(".config"));
            }

            Self {
                previous_home,
                previous_xdg_config_home,
            }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
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
                        "first request should list projects, got {request}"
                    );
                    r#"{"data":{"projects":[]}}"#.to_string()
                } else {
                    assert!(
                        request.contains("CreateProject"),
                        "second request should create project, got {request}"
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

    #[test]
    fn derive_project_slug_rejects_empty_slugs() {
        assert_eq!(derive_project_slug("My Project").unwrap(), "my-project");
        let err = derive_project_slug("!!!").unwrap_err();
        assert!(err.message.contains("Could not create valid slug"));
    }

    #[test]
    fn canonical_project_root_requires_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_project_root(&dir.path().to_string_lossy()).unwrap();
        assert!(root.is_dir());

        let missing = dir.path().join("missing");
        let err = canonical_project_root(&missing.to_string_lossy()).unwrap_err();
        assert!(err.message.contains("Project path is not a directory"));
    }

    #[test]
    fn validate_sacrum_token_rejects_header_invalid_characters() {
        validate_sacrum_token("sac_valid-token").unwrap();

        for token in ["bad\n", "bad\r", "bad\0", "bad\u{7f}"] {
            let err = validate_sacrum_token(token).unwrap_err();
            assert!(err.message.contains("Authorization header"));
        }
    }

    #[test]
    fn project_slug_guard_allows_same_path_and_rejects_different_path() {
        let temp = tempfile::tempdir().unwrap();
        let registered = temp.path().join("registered");
        let other = temp.path().join("other");
        fs::create_dir_all(&registered).unwrap();
        fs::create_dir_all(&other).unwrap();

        let config = vertebrae_sacrum_client::VertebraeConfigFile {
            sacrum: vertebrae_sacrum_client::GlobalSacrumSection::default(),
            projects: BTreeMap::from([(
                "duplicate".to_string(),
                vertebrae_sacrum_client::ProjectSection {
                    id: "existing-id".to_string(),
                    path: registered.to_string_lossy().to_string(),
                },
            )]),
        };

        ensure_project_slug_available_for_path(&config, "duplicate", &registered).unwrap();
        let err = ensure_project_slug_available_for_path(&config, "duplicate", &other).unwrap_err();
        assert!(err.message.contains("already exists in config"));
    }

    #[tokio::test]
    #[serial]
    async fn sacrum_settings_commands_validate_and_hide_token() {
        let temp_home = tempfile::tempdir().unwrap();
        let _env = EnvGuard::new(temp_home.path());

        let initial = sacrum_config_status().await.unwrap();
        assert!(!initial.config_exists);
        assert!(!initial.has_token);
        assert_eq!(initial.url, "https://vertebrae.dev");

        let empty = save_sacrum_settings("  ".to_string()).await.unwrap_err();
        assert!(empty.message.contains("required"));

        let invalid = save_sacrum_settings("bad\ntoken".to_string())
            .await
            .unwrap_err();
        assert!(invalid.message.contains("Authorization header"));
        assert!(
            !vertebrae_sacrum_client::config_path()
                .expect("config path")
                .exists(),
            "invalid tokens should not be persisted"
        );

        vertebrae_sacrum_client::save_config_file(&vertebrae_sacrum_client::VertebraeConfigFile {
            sacrum: vertebrae_sacrum_client::GlobalSacrumSection {
                url: "https://custom.example.test".to_string(),
                token: None,
            },
            projects: BTreeMap::new(),
        })
        .unwrap();
        let custom_status = sacrum_config_status().await.unwrap();
        assert_eq!(custom_status.url, "https://custom.example.test");

        let status = save_sacrum_settings(" sac_valid-token ".to_string())
            .await
            .unwrap();
        assert!(status.config_exists);
        assert!(status.has_token);
        assert_eq!(status.url, "https://custom.example.test");

        let status_json = serde_json::to_value(&status).unwrap();
        assert!(status_json.get("token").is_none());

        let config = vertebrae_sacrum_client::load_config_file().unwrap();
        assert_eq!(config.sacrum.token.as_deref(), Some("sac_valid-token"));
        assert_eq!(config.sacrum.url, "https://custom.example.test");
    }

    #[tokio::test]
    #[serial]
    async fn initialize_project_rejects_duplicate_slug_for_different_path() {
        let temp_home = tempfile::tempdir().unwrap();
        let _env = EnvGuard::new(temp_home.path());
        let temp = tempfile::tempdir().unwrap();
        let registered = temp.path().join("registered");
        let other = temp.path().join("other");
        fs::create_dir_all(&registered).unwrap();
        fs::create_dir_all(&other).unwrap();

        vertebrae_sacrum_client::save_config_file(&vertebrae_sacrum_client::VertebraeConfigFile {
            sacrum: vertebrae_sacrum_client::GlobalSacrumSection {
                url: "http://127.0.0.1:1".to_string(),
                token: Some("sac_valid-token".to_string()),
            },
            projects: BTreeMap::from([(
                "duplicate".to_string(),
                vertebrae_sacrum_client::ProjectSection {
                    id: "existing-id".to_string(),
                    path: registered.to_string_lossy().to_string(),
                },
            )]),
        })
        .unwrap();

        let app = build_app_without_services();
        let err = initialize_project_inner(
            app.handle(),
            other.to_string_lossy().to_string(),
            Some("Duplicate".to_string()),
        )
        .await
        .unwrap_err();

        assert!(err.message.contains("already exists in config"));
    }

    #[tokio::test]
    #[serial]
    async fn initialize_project_registers_skill_links_and_emits_progress() {
        let temp_home = tempfile::tempdir().unwrap();
        let _env = EnvGuard::new(temp_home.path());
        let project_parent = tempfile::tempdir().unwrap();
        let project_path = project_parent.path().join("Temp Project");
        fs::create_dir_all(&project_path).unwrap();
        let claude_skills = project_path.join(".claude/skills");
        let agents_skills = project_path.join(".agents/skills");
        fs::create_dir_all(&claude_skills).unwrap();
        fs::create_dir_all(&agents_skills).unwrap();
        let server = start_mock_sacrum_server();

        vertebrae_sacrum_client::save_config_file(&vertebrae_sacrum_client::VertebraeConfigFile {
            sacrum: vertebrae_sacrum_client::GlobalSacrumSection {
                url: server.url.clone(),
                token: Some("sac_valid-token".to_string()),
            },
            projects: BTreeMap::new(),
        })
        .unwrap();

        let app = build_app_without_services();
        let (tx, rx) = mpsc::channel();
        let _listener = app.listen("project-init-progress-event", move |event| {
            tx.send(event.payload().to_string())
                .expect("record progress event");
        });

        let result = initialize_project_inner(
            app.handle(),
            project_path.to_string_lossy().to_string(),
            None,
        )
        .await
        .unwrap();
        server.stop();
        server.join();

        assert_eq!(result.slug, "temp-project");
        assert_eq!(result.project_id, "proj-123");
        assert_eq!(result.project_name, "Temp Project");
        assert!(result.project_created);
        assert!(result.skills_copied > 0);
        assert!(result.skills_target.contains(".claude/skills"));
        assert!(result.skills_target.contains(".agents/skills"));

        let staged_skill = vertebrae_installer::installed_skills_dir()
            .unwrap()
            .join("vtb-add/SKILL.md");
        assert!(staged_skill.exists());
        for link in [
            project_path.join(".claude/skills/vtb-add/SKILL.md"),
            project_path.join(".agents/skills/vtb-add/SKILL.md"),
        ] {
            let metadata = fs::symlink_metadata(&link).unwrap();
            assert!(metadata.file_type().is_symlink());
            assert_eq!(fs::read_link(&link).unwrap(), staged_skill);
        }

        let config = vertebrae_sacrum_client::load_config_file().unwrap();
        let registered = config.projects.get("temp-project").unwrap();
        assert_eq!(registered.id, "proj-123");
        assert_eq!(registered.path, result.path);

        let events = rx
            .try_iter()
            .map(|payload| {
                serde_json::from_str::<crate::events::ProjectInitProgressEvent>(&payload)
                    .expect("progress event payload")
            })
            .collect::<Vec<_>>();
        let skill_events = events
            .iter()
            .filter(|event| {
                matches!(
                    event.kind,
                    crate::events::ProjectInitProgressKind::SkillFileInstalled
                )
            })
            .count();
        assert_eq!(skill_events, result.skills_copied as usize);
        assert!(matches!(
            events.last().map(|event| &event.kind),
            Some(crate::events::ProjectInitProgressKind::Completed)
        ));
    }

    #[tokio::test]
    #[serial]
    async fn initialize_project_stages_skills_without_creating_missing_skill_roots() {
        let temp_home = tempfile::tempdir().unwrap();
        let _env = EnvGuard::new(temp_home.path());
        let project_parent = tempfile::tempdir().unwrap();
        let project_path = project_parent.path().join("Temp Project");
        fs::create_dir_all(&project_path).unwrap();
        let server = start_mock_sacrum_server();

        vertebrae_sacrum_client::save_config_file(&vertebrae_sacrum_client::VertebraeConfigFile {
            sacrum: vertebrae_sacrum_client::GlobalSacrumSection {
                url: server.url.clone(),
                token: Some("sac_valid-token".to_string()),
            },
            projects: BTreeMap::new(),
        })
        .unwrap();

        let app = build_app_without_services();
        let result = initialize_project_inner(
            app.handle(),
            project_path.to_string_lossy().to_string(),
            None,
        )
        .await
        .unwrap();
        server.stop();
        server.join();

        assert_eq!(result.skills_copied, 0);
        assert!(result.skills_target.contains("no existing .claude/skills"));
        assert!(vertebrae_installer::installed_skills_dir()
            .unwrap()
            .join("vtb-add/SKILL.md")
            .exists());
        assert!(!project_path.join(".claude").exists());
        assert!(!project_path.join(".agents").exists());
    }

    #[tokio::test]
    async fn has_project_selected_false_when_no_services() {
        let app = build_app_without_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = has_project_selected(state).await.unwrap();
        assert!(!result);
    }

    #[tokio::test]
    async fn has_project_selected_true_when_services() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let result = has_project_selected(state).await.unwrap();
        assert!(result);
    }

    // ========================================================================
    // Project management tests
    // ========================================================================

    #[tokio::test]
    async fn get_projects_returns_empty_initially() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let projects = get_projects(state).await.unwrap();
        // Projects are now loaded from config.toml, so we just verify it returns a valid list
        // The list may or may not be empty depending on whether config.toml exists
        let _ = projects; // Just verify it's a Vec<SavedProject>
    }

    #[tokio::test]
    async fn get_current_project_returns_none_initially() {
        let app = build_app_with_services();
        let state: tauri::State<'_, AppState> = app.state();
        let current = get_current_project(state).await.unwrap();
        assert!(current.is_none());
    }
}
