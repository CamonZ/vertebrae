use super::CommandError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

const APPLICATION_EDITOR_PREFIX: &str = "app:";
const COMMAND_EDITOR_PREFIX: &str = "command:";

/// An application or editor command that can open local source/text files.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEditor {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Return applications and known editor commands that can open local files.
#[tauri::command]
#[specta::specta]
pub fn get_local_file_editors() -> Result<Vec<LocalFileEditor>, CommandError> {
    let mut editors = Vec::new();

    #[cfg(target_os = "macos")]
    {
        editors.extend(macos_local_file_editors()?);
    }

    editors.extend(command_local_file_editors());
    editors = deduplicate_editors(editors);
    editors.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });
    Ok(editors)
}

fn deduplicate_editors(editors: Vec<LocalFileEditor>) -> Vec<LocalFileEditor> {
    let mut by_name = BTreeMap::<String, LocalFileEditor>::new();

    for editor in editors {
        let identity = editor_identity(&editor.name);
        match by_name.get(&identity) {
            Some(existing) if is_application_editor(existing) => continue,
            Some(existing) if !is_application_editor(&editor) && existing.path <= editor.path => {
                continue;
            }
            _ => {}
        }
        by_name.insert(identity, editor);
    }

    by_name.into_values().collect()
}

fn editor_identity(name: &str) -> String {
    name.strip_suffix(" (command)")
        .unwrap_or(name)
        .trim()
        .to_ascii_lowercase()
}

fn is_application_editor(editor: &LocalFileEditor) -> bool {
    editor.id.starts_with(APPLICATION_EDITOR_PREFIX)
}

/// Open a validated local file using either the selected application bundle or
/// the selected editor command. Bare application paths remain supported for
/// settings persisted by older builds.
pub fn open_local_file_with_editor(
    app_handle: &tauri::AppHandle,
    file: &Path,
    line: Option<u32>,
    column: Option<u32>,
    editor: Option<&str>,
) -> Result<(), CommandError> {
    if let Some(editor) = editor.filter(|editor| !editor.is_empty()) {
        if let Some(command_path) = editor.strip_prefix(COMMAND_EDITOR_PREFIX) {
            return spawn_editor_command(command_path, file, line, column);
        }

        let application_path = editor
            .strip_prefix(APPLICATION_EDITOR_PREFIX)
            .unwrap_or(editor);
        if let Some(emacs_command) = emacs_command_for_application(application_path) {
            return spawn_editor_command(&emacs_command.to_string_lossy(), file, line, column);
        }
        return tauri_plugin_opener::OpenerExt::opener(app_handle)
            .open_path(
                file.to_string_lossy().to_string(),
                Some(application_path.to_string()),
            )
            .map_err(|error| CommandError {
                message: format!("Could not open local file: {error}"),
            });
    }

    tauri_plugin_opener::OpenerExt::opener(app_handle)
        .open_path(file.to_string_lossy().to_string(), None::<String>)
        .map_err(|error| CommandError {
            message: format!("Could not open local file: {error}"),
        })
}

fn spawn_editor_command(
    command_path: &str,
    file: &Path,
    line: Option<u32>,
    column: Option<u32>,
) -> Result<(), CommandError> {
    let command_path = Path::new(command_path);
    if !command_path.is_file() {
        return Err(CommandError {
            message: format!("Configured editor command does not exist: {command_path:?}"),
        });
    }

    let command_name = command_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let is_emacs_client = command_name.eq_ignore_ascii_case("emacsclient");
    let is_emacs = is_emacs_client || command_name.eq_ignore_ascii_case("emacs");

    let mut command = Command::new(command_path);
    if is_emacs_client {
        command.arg("--no-wait");
    }
    if is_emacs {
        if let Some(location) = emacs_location_argument(line, column) {
            command.arg(location);
        }
    }
    command.arg(file);
    command.spawn().map(|_| ()).map_err(|error| CommandError {
        message: format!("Could not launch editor command {command_path:?}: {error}"),
    })
}

fn emacs_location_argument(line: Option<u32>, column: Option<u32>) -> Option<String> {
    line.map(|line| match column {
        Some(column) => format!("+{line}:{column}"),
        None => format!("+{line}"),
    })
}

fn emacs_command_for_application(application_path: &str) -> Option<std::path::PathBuf> {
    let application_path = Path::new(application_path);
    match application_path.file_name()?.to_str()? {
        "Emacs.app" => {
            let executable = application_path.join("Contents/MacOS/Emacs");
            executable.is_file().then_some(executable)
        }
        "Emacs Client.app" => command_on_path("emacsclient"),
        _ => None,
    }
}

fn command_local_file_editors() -> Vec<LocalFileEditor> {
    // These commands are GUI-capable editors whose binaries accept a file
    // path. Terminal-only editors are intentionally excluded because a GUI
    // process cannot provide them a useful terminal.
    [
        ("emacsclient", "Emacs Client"),
        ("emacs", "Emacs"),
        ("code", "Visual Studio Code"),
        ("cursor", "Cursor"),
        ("zed", "Zed"),
        ("subl", "Sublime Text"),
    ]
    .into_iter()
    .filter_map(|(command, name)| {
        let path = command_on_path(command)?;
        let path = path.to_string_lossy().into_owned();
        Some(LocalFileEditor {
            id: format!("{COMMAND_EDITOR_PREFIX}{path}"),
            name: format!("{name} (command)"),
            path,
        })
    })
    .collect()
}

fn command_on_path(command: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH");
    let mut directories = path
        .as_deref()
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    // A macOS GUI app launched from Finder does not reliably inherit the
    // shell PATH. Include the standard Homebrew locations so a command such
    // as `/opt/homebrew/bin/emacsclient` remains discoverable there too.
    for directory in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let directory = std::path::PathBuf::from(directory);
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }

    directories
        .into_iter()
        .map(|directory| directory.join(command))
        .find(|path| path.is_file())
}

#[cfg(target_os = "macos")]
fn macos_local_file_editors() -> Result<Vec<LocalFileEditor>, CommandError> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSArray, NSURL};
    use objc2_uniform_type_identifiers::{UTTypePlainText, UTTypeSourceCode, UTTypeText};

    let workspace = NSWorkspace::sharedWorkspace();
    let mut editors = BTreeMap::<String, LocalFileEditor>::new();

    let mut add_applications = |applications: &NSArray<NSURL>| {
        for index in 0..applications.count() {
            let application_url = applications.objectAtIndex(index);
            let Some(application_path) = application_url.to_file_path() else {
                continue;
            };
            if !application_path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
            {
                continue;
            }

            let path = application_path.to_string_lossy().into_owned();
            let name = application_path
                .file_stem()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            editors.entry(path.clone()).or_insert(LocalFileEditor {
                id: format!("{APPLICATION_EDITOR_PREFIX}{path}"),
                name,
                path,
            });
        }
    };

    // This is the important part: use Launch Services' generic content types
    // instead of making the picker depend on whether an app registered a
    // particular extension such as `.rs` or `.tsx`.
    // These are immutable framework-owned UTI singletons.
    let content_types = unsafe { [UTTypeText, UTTypePlainText, UTTypeSourceCode] };
    for content_type in content_types {
        add_applications(&workspace.URLsForApplicationsToOpenContentType(content_type));
    }

    // Keep extension lookups as a fallback for applications that register a
    // language extension but do not advertise the generic source-code UTI.
    for extension in ["txt", "md", "rs", "ts", "tsx", "js", "py"] {
        let sample_path = format!("/tmp/vertebrae-file-reference.{extension}");
        let Some(sample_url) = NSURL::from_file_path(&sample_path) else {
            continue;
        };
        add_applications(&workspace.URLsForApplicationsToOpenURL(&sample_url));
    }

    Ok(editors.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_editor_ids_use_a_distinct_namespace() {
        let editors = command_local_file_editors();
        for editor in editors {
            assert!(editor.id.starts_with(COMMAND_EDITOR_PREFIX));
        }
    }

    #[test]
    fn application_editor_ids_use_a_distinct_namespace() {
        let editor = LocalFileEditor {
            id: format!("{APPLICATION_EDITOR_PREFIX}/Applications/Emacs.app"),
            name: "Emacs".to_string(),
            path: "/Applications/Emacs.app".to_string(),
        };

        assert!(editor.id.starts_with(APPLICATION_EDITOR_PREFIX));
    }

    #[test]
    fn emacs_location_arguments_preserve_line_and_column_suffixes() {
        assert_eq!(
            emacs_location_argument(Some(29), Some(4)),
            Some("+29:4".to_string())
        );
        assert_eq!(
            emacs_location_argument(Some(29), None),
            Some("+29".to_string())
        );
        assert_eq!(emacs_location_argument(None, Some(4)), None);
    }

    #[test]
    fn emacs_application_bundles_resolve_to_line_aware_commands() {
        let emacs = emacs_command_for_application("/Applications/Emacs.app");
        if Path::new("/Applications/Emacs.app").is_dir() {
            assert_eq!(
                emacs.as_deref(),
                Some(Path::new("/Applications/Emacs.app/Contents/MacOS/Emacs"))
            );
        }

        if Path::new("/Applications/Emacs Client.app").is_dir() {
            assert!(emacs_command_for_application("/Applications/Emacs Client.app").is_some());
        }
    }

    #[test]
    fn deduplication_prefers_the_application_over_its_command_wrapper() {
        let editors = deduplicate_editors(vec![
            LocalFileEditor {
                id: "command:/opt/homebrew/bin/code".to_string(),
                name: "Visual Studio Code (command)".to_string(),
                path: "/opt/homebrew/bin/code".to_string(),
            },
            LocalFileEditor {
                id: "app:/Applications/Visual Studio Code.app".to_string(),
                name: "Visual Studio Code".to_string(),
                path: "/Applications/Visual Studio Code.app".to_string(),
            },
        ]);

        assert_eq!(editors.len(), 1);
        assert_eq!(editors[0].id, "app:/Applications/Visual Studio Code.app");
    }
}
