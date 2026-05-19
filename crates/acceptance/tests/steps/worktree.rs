use cucumber::{given, then, when};
use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::{SmokeWorld, WorktreeFixture};

fn config_subpath() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("Library/Application Support/vertebrae/config.toml")
    } else {
        PathBuf::from(".config/vertebrae/config.toml")
    }
}

async fn run_git(repo: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(args)
        .current_dir(repo)
        .status()
        .await
        .expect("failed to spawn git");
    assert!(status.success(), "git {:?} failed in {:?}", args, repo);
}

async fn run_jj(repo: &Path, args: &[&str]) {
    let status = Command::new("jj")
        .args(args)
        .current_dir(repo)
        .status()
        .await
        .expect("failed to spawn jj");
    assert!(status.success(), "jj {:?} failed in {:?}", args, repo);
}

async fn assert_git_root_unavailable(repo: &Path) {
    let status = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(repo)
        .status()
        .await
        .expect("failed to spawn git");
    assert!(
        !status.success(),
        "git root unexpectedly resolved in non-colocated JJ workspace {:?}",
        repo
    );
}

#[given("the project is registered at a temporary git repository")]
async fn given_registered_temp_repo(world: &mut SmokeWorld) {
    let project_id = world
        .env
        .get("VTB_PROJECT_ID")
        .expect("VTB_PROJECT_ID set by Sacrum client setup")
        .clone();

    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().to_path_buf();
    let main_repo = home.join("repo");
    std::fs::create_dir_all(&main_repo).unwrap();
    let main_repo = main_repo.canonicalize().unwrap();

    run_git(&main_repo, &["init", "-q", "-b", "main"]).await;
    run_git(&main_repo, &["config", "user.email", "test@example.com"]).await;
    run_git(&main_repo, &["config", "user.name", "Test"]).await;
    std::fs::write(main_repo.join("README.md"), "init").unwrap();
    run_git(&main_repo, &["add", "."]).await;
    run_git(&main_repo, &["commit", "-q", "-m", "init"]).await;

    let config_path = home.join(config_subpath());
    std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

    let url = world.env.get("VTB_URL").cloned().unwrap_or_default();
    let token = world.env.get("VTB_TOKEN").cloned().unwrap_or_default();
    let main_repo_str = main_repo.to_string_lossy().to_string();
    let config_doc = format!(
        "[sacrum]\nurl = \"{}\"\ntoken = \"{}\"\n\n[projects.acceptance]\nid = \"{}\"\npath = \"{}\"\n",
        url, token, project_id, main_repo_str
    );
    std::fs::write(&config_path, config_doc).unwrap();

    world.worktree = Some(WorktreeFixture {
        _tmp: tmp,
        home,
        main_repo,
        worktree_path: PathBuf::new(),
    });
}

#[given("the project is registered at a temporary non-colocated JJ workspace")]
async fn given_registered_non_colocated_jj_workspace(world: &mut SmokeWorld) {
    let project_id = world
        .env
        .get("VTB_PROJECT_ID")
        .expect("VTB_PROJECT_ID set by Sacrum client setup")
        .clone();

    let tmp = tempfile::tempdir().expect("tempdir");
    let home = tmp.path().to_path_buf();
    let workspace = home.join("jj-workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let workspace = workspace.canonicalize().unwrap();

    run_jj(&workspace, &["git", "init", "--no-colocate"]).await;
    assert_git_root_unavailable(&workspace).await;

    let nested_dir = workspace.join("nested");
    std::fs::create_dir_all(&nested_dir).unwrap();
    let nested_dir = nested_dir.canonicalize().unwrap();

    let config_path = home.join(config_subpath());
    std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();

    let url = world.env.get("VTB_URL").cloned().unwrap_or_default();
    let token = world.env.get("VTB_TOKEN").cloned().unwrap_or_default();
    let workspace_str = workspace.to_string_lossy().to_string();
    let config_doc = format!(
        "[sacrum]\nurl = \"{}\"\ntoken = \"{}\"\n\n[projects.acceptance]\nid = \"{}\"\npath = \"{}\"\n",
        url, token, project_id, workspace_str
    );
    std::fs::write(&config_path, config_doc).unwrap();

    world.worktree = Some(WorktreeFixture {
        _tmp: tmp,
        home,
        main_repo: workspace,
        worktree_path: nested_dir,
    });
}

#[given("a git worktree of that repository")]
async fn given_worktree(world: &mut SmokeWorld) {
    let fixture = world.worktree.as_mut().expect("worktree fixture set up");
    let worktree_path = fixture.home.join("wt");
    run_git(
        &fixture.main_repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            worktree_path.to_str().unwrap(),
        ],
    )
    .await;
    fixture.worktree_path = worktree_path.canonicalize().unwrap();
}

#[when(expr = "I run vtb add {string} from the worktree directory")]
async fn when_run_add_from_worktree(world: &mut SmokeWorld, title: String) {
    run_add_from_vcs_workspace(world, title).await;
}

#[when(expr = "I run vtb add {string} from the VCS workspace directory")]
async fn when_run_add_from_vcs_workspace(world: &mut SmokeWorld, title: String) {
    run_add_from_vcs_workspace(world, title).await;
}

async fn run_add_from_vcs_workspace(world: &mut SmokeWorld, title: String) {
    let fixture = world
        .worktree
        .as_ref()
        .expect("worktree fixture")
        .clone_paths();
    let home_str = fixture.0.to_string_lossy().to_string();
    world
        .run_vtb_in(
            &fixture.1,
            &[("HOME", Some(&home_str)), ("VTB_PROJECT_ID", None)],
            &["add", &title],
        )
        .await;
    if let Some(id) = world.extract_task_id_from_output() {
        world.track_task(id);
    }
}

#[then("the command succeeds")]
async fn then_command_succeeds(world: &mut SmokeWorld) {
    assert_eq!(
        world.last_exit_code, 0,
        "vtb command failed: stdout={} stderr={}",
        world.last_stdout, world.last_stderr
    );
}

#[then("the created task belongs to the configured project")]
async fn then_task_in_project(world: &mut SmokeWorld) {
    let task_id = world.task_id.as_ref().expect("task created").clone();
    let client = world
        .graphql_client
        .as_ref()
        .expect("graphql client configured");
    let task_service = vertebrae_sacrum_client::SacrumTaskService::new(client.clone());
    let task = vertebrae_core::service::TaskService::get_task(&task_service, &task_id)
        .await
        .expect("task fetch should succeed via the configured project");
    assert_eq!(task.id, task_id);
}

impl WorktreeFixture {
    fn clone_paths(&self) -> (PathBuf, PathBuf) {
        (self.home.clone(), self.worktree_path.clone())
    }
}
