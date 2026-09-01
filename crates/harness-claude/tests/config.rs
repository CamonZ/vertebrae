use std::{collections::BTreeMap, ffi::OsString, fs};

use serde_json::json;
use tempfile::TempDir;
use vertebrae_harness_claude::{
    ClaudeLaunchMode, ClaudePermissionMode, ClaudeProviderConfig, ClaudeProviderPrelude,
};
use vertebrae_harness_core::{RequestConfig, SpeedTier};

#[test]
fn persistent_and_resumed_specs_preserve_exact_provider_configuration() {
    let temp = TempDir::new().unwrap();
    let executable = temp.path().join("claude");
    fs::write(&executable, "fixture").unwrap();
    let cwd = temp.path().join("project");
    fs::create_dir(&cwd).unwrap();
    let plugin = temp.path().join("plugin");
    let skills = temp.path().join("installed-skills");
    let agent = temp.path().join("agent.md");
    let settings = temp.path().join("settings.json");
    let config = ClaudeProviderConfig {
        executable: Some(executable.clone()),
        search_path: Some(OsString::from("/fixture/bin")),
        environment: BTreeMap::from([("CLAUDE_COMPAT".into(), "provider".into())]),
        prelude: ClaudeProviderPrelude {
            settings_path: Some(settings.clone()),
            args: vec!["--strict-mcp-config".into()],
        },
        plugin_roots: vec![plugin.clone()],
        installed_skills_roots: vec![skills.clone()],
        agent_paths: vec![agent.clone()],
        permission_mode: Some(ClaudePermissionMode::Plan),
        permission_prompt_tool: Some("mcp__gate__permission_prompt".into()),
        mcp_config: Some(json!({"mcpServers":{"gate":{"command":"gate"}}})),
        extra_args: vec!["--debug".into()],
        ..ClaudeProviderConfig::default()
    };
    let request = RequestConfig {
        verbosity: None,
        working_directory: Some(cwd.clone()),
        model: Some("opus".into()),
        output_schema: Some(json!({"type":"object"})),
        environment: BTreeMap::from([
            ("CLAUDE_COMPAT".into(), "request".into()),
            ("REQUEST_ONLY".into(), "yes".into()),
        ]),
        ..RequestConfig::default()
    };

    let initial = config
        .command_spec(ClaudeLaunchMode::Persistent { resume_id: None }, &request)
        .unwrap();
    assert_eq!(initial.program, executable);
    assert_eq!(initial.current_dir, Some(cwd));
    assert_eq!(initial.environment["PATH"], "/fixture/bin");
    assert_eq!(initial.environment["CLAUDE_COMPAT"], "request");
    assert_eq!(initial.environment["REQUEST_ONLY"], "yes");
    assert_eq!(
        &initial.args[..3],
        &[
            "--settings".to_string(),
            settings.to_string_lossy().into_owned(),
            "--strict-mcp-config".to_string(),
        ]
    );
    let plugin_values = values_after(&initial.args, "--plugin-dir");
    assert_eq!(plugin_values[0], plugin.to_string_lossy());
    assert_eq!(plugin_values[1], skills.to_string_lossy());
    assert!(
        initial
            .args
            .windows(2)
            .any(|pair| pair == ["--input-format", "stream-json"])
    );
    let settings_index = index_of(&initial.args, "--settings");
    for flag in [
        "--model",
        "--json-schema",
        "--permission-mode",
        "--plugin-dir",
        "--agent",
    ] {
        assert!(
            settings_index < index_of(&initial.args, flag),
            "--settings must precede {flag}"
        );
    }
    assert_eq!(
        values_after(&initial.args, "--agent"),
        vec![agent.to_string_lossy()]
    );
    assert!(index_of(&initial.args, "--debug") > index_of(&initial.args, "--json-schema"));
    assert_eq!(initial.args.last().unwrap(), "--debug");
    assert!(
        initial
            .args
            .windows(2)
            .any(|pair| pair == ["--model", "opus"])
    );
    assert!(
        initial
            .args
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "plan"])
    );
    assert!(!initial.args.iter().any(|arg| arg.starts_with("--resume=")));

    let resumed = config
        .command_spec(
            ClaudeLaunchMode::Persistent {
                resume_id: Some("conversation-1"),
            },
            &request,
        )
        .unwrap();
    assert!(
        index_of(&resumed.args, "--resume=conversation-1") < index_of(&resumed.args, "--debug")
    );
    assert_eq!(resumed.args.last().unwrap(), "--debug");
}

#[test]
fn request_personality_is_translated_by_the_claude_adapter() {
    let temp = TempDir::new().expect("temporary directory");
    let executable = temp.path().join("claude");
    fs::write(&executable, "fixture").expect("placeholder executable");
    let config = ClaudeProviderConfig {
        executable: Some(executable),
        ..ClaudeProviderConfig::default()
    };
    let request = RequestConfig {
        verbosity: None,
        personality: Some("Explanatory".into()),
        ..RequestConfig::default()
    };

    let spec = config
        .command_spec(ClaudeLaunchMode::Persistent { resume_id: None }, &request)
        .expect("command spec");

    assert_eq!(spec.args[0], "--settings");
    assert_eq!(spec.args[1], r#"{"outputStyle":"Explanatory"}"#);
}

#[test]
fn one_shot_spec_uses_print_stream_json_and_verbatim_prompt() {
    let temp = TempDir::new().unwrap();
    let executable = temp.path().join("claude");
    fs::write(&executable, "fixture").unwrap();
    let config = ClaudeProviderConfig {
        executable: Some(executable),
        ..ClaudeProviderConfig::default()
    };
    let prompt = "line one\nline two --not-a-flag";
    let spec = config
        .command_spec(
            ClaudeLaunchMode::OneShot { prompt },
            &RequestConfig::default(),
        )
        .unwrap();
    assert_eq!(values_after(&spec.args, "--print"), vec![prompt]);
    assert!(
        spec.args
            .windows(2)
            .any(|pair| pair == ["--output-format", "stream-json"])
    );
    assert!(spec.args.contains(&"--verbose".into()));
    assert!(spec.args.contains(&"--include-partial-messages".into()));
    assert!(!spec.args.contains(&"--input-format".into()));
}

#[test]
fn speed_tier_is_passed_as_an_inline_settings_override() {
    let temp = TempDir::new().unwrap();
    let executable = temp.path().join("claude");
    fs::write(&executable, "fixture").unwrap();
    let config = ClaudeProviderConfig {
        executable: Some(executable),
        ..ClaudeProviderConfig::default()
    };
    let request = RequestConfig {
        verbosity: None,
        speed_tier: Some(SpeedTier::Fast),
        ..RequestConfig::default()
    };
    let spec = config
        .command_spec(ClaudeLaunchMode::Persistent { resume_id: None }, &request)
        .unwrap();
    assert!(
        spec.args
            .windows(2)
            .any(|pair| { pair[0] == "--settings" && pair[1] == r#"{"fastMode":true}"# })
    );
}

#[test]
fn permission_modes_match_current_claude_cli_values() {
    for (mode, expected) in [
        (ClaudePermissionMode::AcceptEdits, "acceptEdits"),
        (ClaudePermissionMode::Auto, "auto"),
        (ClaudePermissionMode::BypassPermissions, "bypassPermissions"),
        (ClaudePermissionMode::Default, "default"),
        (ClaudePermissionMode::DontAsk, "dontAsk"),
        (ClaudePermissionMode::Plan, "plan"),
    ] {
        assert_eq!(mode.as_cli_value(), expected);
    }
}

#[test]
fn discovery_checks_compatibility_environment_then_search_path() {
    let temp = TempDir::new().unwrap();
    let env_binary = temp.path().join("env-claude");
    fs::write(&env_binary, "fixture").unwrap();
    let config = ClaudeProviderConfig {
        executable: None,
        environment: BTreeMap::from([(
            "CLAUDE_CODE_PATH".into(),
            env_binary.to_string_lossy().into_owned(),
        )]),
        ..ClaudeProviderConfig::default()
    };
    assert_eq!(config.resolve_executable().unwrap(), env_binary);

    let path_binary = temp.path().join(binary_name());
    fs::write(&path_binary, "fixture").unwrap();
    let config = ClaudeProviderConfig {
        executable: None,
        executable_environment_key: "FIXTURE_CLAUDE_PATH_NOT_SET".into(),
        search_path: Some(temp.path().as_os_str().to_owned()),
        ..ClaudeProviderConfig::default()
    };
    assert_eq!(config.resolve_executable().unwrap(), path_binary);
}

fn values_after<'a>(args: &'a [String], flag: &str) -> Vec<&'a str> {
    args.iter()
        .enumerate()
        .filter(|(_, arg)| arg.as_str() == flag)
        .filter_map(|(index, _)| args.get(index + 1))
        .map(String::as_str)
        .collect()
}

fn index_of(args: &[String], value: &str) -> usize {
    args.iter()
        .position(|argument| argument == value)
        .unwrap_or_else(|| panic!("missing argument {value}"))
}

#[cfg(windows)]
fn binary_name() -> &'static str {
    "claude.exe"
}

#[cfg(not(windows))]
fn binary_name() -> &'static str {
    "claude"
}
