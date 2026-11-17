use super::CommandError;

/// List installed font family names available to Appearance settings.
#[tauri::command]
#[specta::specta]
pub fn get_local_font_families() -> Result<Vec<String>, CommandError> {
    let mut families = installed_font_families()?;
    families.retain(|name| !name.trim().is_empty());
    families.sort_unstable();
    families.dedup();
    Ok(families)
}

#[cfg(target_os = "macos")]
fn installed_font_families() -> Result<Vec<String>, CommandError> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSFontManager;

    let main_thread = MainThreadMarker::new().ok_or_else(|| CommandError {
        message: "Font discovery requires the main thread.".into(),
    })?;
    let families = NSFontManager::sharedFontManager(main_thread).availableFontFamilies();
    Ok((0..families.count())
        .map(|index| families.objectAtIndex(index).to_string())
        .collect())
}

#[cfg(target_os = "linux")]
fn installed_font_families() -> Result<Vec<String>, CommandError> {
    let output = std::process::Command::new("fc-list")
        .args(["--format", "%{family[0]}\n"])
        .output()
        .map_err(|error| CommandError {
            message: format!("Could not list installed fonts: {error}"),
        })?;
    if !output.status.success() {
        return Err(CommandError {
            message: "Fontconfig could not list installed fonts.".into(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_owned)
        .collect())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn installed_font_families() -> Result<Vec<String>, CommandError> {
    Err(CommandError {
        message: "Installed font discovery is unavailable on this platform.".into(),
    })
}
