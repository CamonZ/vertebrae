use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

use vertebrae_harness_core::HarnessError;

#[derive(Clone)]
pub struct MistralVibeConfig {
    pub executable: Option<PathBuf>,
    pub executable_environment_key: String,
    pub search_path: Option<OsString>,
    pub environment: BTreeMap<String, String>,
    pub required_version: String,
    pub startup_timeout: Duration,
    pub turn_timeout: Duration,
    pub cleanup_timeout: Duration,
}

impl std::fmt::Debug for MistralVibeConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MistralVibeConfig")
            .field("executable", &self.executable)
            .field(
                "executable_environment_key",
                &self.executable_environment_key,
            )
            .field("search_path", &self.search_path)
            .field("environment", &self.environment.keys().collect::<Vec<_>>())
            .field("required_version", &self.required_version)
            .field("startup_timeout", &self.startup_timeout)
            .field("turn_timeout", &self.turn_timeout)
            .field("cleanup_timeout", &self.cleanup_timeout)
            .finish()
    }
}

impl Default for MistralVibeConfig {
    fn default() -> Self {
        Self {
            executable: None,
            executable_environment_key: "MISTRAL_VIBE_SERVER".into(),
            search_path: env::var_os("PATH"),
            environment: BTreeMap::new(),
            required_version: "2.26.1".into(),
            startup_timeout: Duration::from_secs(30),
            turn_timeout: Duration::from_secs(120),
            cleanup_timeout: Duration::from_secs(2),
        }
    }
}

impl MistralVibeConfig {
    pub fn resolve_executable(&self) -> Result<PathBuf, HarnessError> {
        if let Some(path) = &self.executable {
            return validate_executable(path);
        }
        if let Some(path) = self
            .environment
            .get(&self.executable_environment_key)
            .map(PathBuf::from)
            .or_else(|| env::var_os(&self.executable_environment_key).map(PathBuf::from))
        {
            return validate_executable(&path);
        }
        for directory in env::split_paths(self.search_path.as_deref().unwrap_or_default()) {
            let candidate = directory.join("vibe-app-server");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
        Err(HarnessError::Unavailable(
            "Mistral Vibe executable was not found; install mistral-vibe 2.26.1 or set MISTRAL_VIBE_SERVER".into(),
        ))
    }
}

fn validate_executable(path: &Path) -> Result<PathBuf, HarnessError> {
    if path.is_file() {
        Ok(path.to_path_buf())
    } else {
        Err(HarnessError::Unavailable(format!(
            "Mistral Vibe executable does not exist: {}",
            path.display()
        )))
    }
}
