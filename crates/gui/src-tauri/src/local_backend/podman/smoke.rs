//! Opt-in only: creates a unique project and cleans up only its own resources.
use super::*;
use crate::local_backend::state::{select_host_port, BackendImageChannel, ProvisioningState};
use crate::local_backend::{compose::ReqwestHealthProbe, manager::LocalBackendManager};

#[tokio::test]
#[ignore = "requires an isolated, running Podman 5.6+ rootless engine and two official Sacrum image digests"]
async fn podman_smoke_provision_reopen_update_and_volume_preservation() {
    assert_eq!(
        std::env::var("VERTEBRAE_TEST_PODMAN").as_deref(),
        Ok("1"),
        "set VERTEBRAE_TEST_PODMAN=1 only for an isolated test runtime"
    );
    let image =
        std::env::var("VERTEBRAE_TEST_SACRUM_IMAGE_REF").expect("first official Sacrum digest");
    let update = std::env::var("VERTEBRAE_TEST_SACRUM_UPDATE_IMAGE_REF")
        .expect("second official Sacrum digest");
    assert_ne!(image, update);
    let non_loopback: std::net::IpAddr = std::env::var("VERTEBRAE_TEST_NON_LOOPBACK_HOST")
        .expect("set this host's non-loopback interface IP for publishing verification")
        .parse()
        .unwrap();
    assert!(!non_loopback.is_loopback() && !non_loopback.is_unspecified());
    // Prove the supplied IP belongs to this host before probing it.
    drop(
        std::net::TcpListener::bind((non_loopback, 0))
            .expect("test ingress IP must belong to this host"),
    );
    let home = dirs::home_dir().expect("home directory shared with Podman machine");
    let temp = tempfile::Builder::new()
        .prefix(".vertebrae-podman-smoke-")
        .tempdir_in(home)
        .unwrap();
    let paths = ManagedStackPaths::from_data_dir(temp.path());
    let runtime = PodmanRuntime::system()
        .await
        .expect("running isolated rootless Podman");
    let mut state = ManagedStackState::fresh_podman(
        image,
        select_host_port(0).unwrap(),
        BackendImageChannel::BackendRelease,
        runtime.target().clone(),
    )
    .unwrap();
    let mut updated = state.clone();
    updated.sacrum_image_ref = update.clone();
    updated
        .validate()
        .expect("second image is an official digest");
    paths.install_assets().unwrap();
    let secrets = paths
        .ensure_runtime_secrets(&RuntimeSecrets::generate().unwrap(), state.kind)
        .unwrap();
    let token = paths
        .ensure_api_token(&ApiToken::generate().unwrap())
        .unwrap();
    let manager = LocalBackendManager::with_runtime(runtime, ReqwestHealthProbe::default());
    let account = SeedAccount::generated_for_installation(state.installation_id).unwrap();

    let result = async {
        manager.start_and_wait_until_healthy(&paths, &mut state).await?;
        manager.runtime.run_seeder(&paths, &state, &account, &token).await?;
        manager.authenticate_backend(&state, &token).await?;
        state.provisioning_state = ProvisioningState::Ready;
        paths.save_state(&state)?;
        let sql = "CREATE TABLE vertebrae_podman_sentinel (value text); INSERT INTO vertebrae_podman_sentinel VALUES ('survived'); SELECT current_setting('wal_level');";
        let settings = manager.runtime.stack(manager.runtime.compose(&paths, &state, "seed Podman smoke sentinel", ["exec", "--no-TTY", "postgres", "psql", "-U", "postgres", "-d", "sacrum_prod", "-tAc", sql]), &secrets).await?;
        if !settings.stdout.contains("logical") { return Err(problem("PostgreSQL logical replication was not enabled")); }
        let saved = paths.load_state()?.ok_or_else(|| problem("saved state missing"))?;
        let volume = saved.postgres_volume();
        let reopened = LocalBackendManager::with_runtime(PodmanRuntime::system_for(saved.podman_target.clone().ok_or_else(|| problem("saved Podman target missing"))?)?, ReqwestHealthProbe::default());
        let mut saved = saved;
        reopened.up_detached(&paths, &mut saved).await?;
        reopened.wait_until_healthy(&paths, &saved).await?;
        reopened.authenticate_backend(&saved, &paths.load_api_token()?).await?;
        reopened.update_sacrum_image(&paths, &saved, &update, None, None, None).await?;
        let final_state = paths.load_state()?.ok_or_else(|| problem("updated state missing"))?;
        if final_state.postgres_volume() != volume { return Err(problem("update changed database identity")); }
        if paths.load_api_token()?.as_str() != token.as_str() { return Err(problem("reopening rotated credentials")); }
        let sentinel = reopened.runtime.stack(reopened.runtime.compose(&paths, &final_state, "check Podman smoke sentinel", ["exec", "--no-TTY", "postgres", "psql", "-U", "postgres", "-d", "sacrum_prod", "-tAc", "SELECT value FROM vertebrae_podman_sentinel;"]), &secrets).await?;
        if !sentinel.stdout.contains("survived") { return Err(problem("database sentinel did not survive the update")); }
        reopened.runtime.verify_loopback(&paths, &final_state, &secrets).await?;
        let ingress = std::net::SocketAddr::new(non_loopback, final_state.host_port);
        let exposed = tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(ingress)).await;
        if matches!(exposed, Ok(Ok(_))) {
            return Err(problem("backend is reachable through a non-loopback host interface"));
        }
        let logs = reopened.runtime.logs(&paths, &final_state, &secrets).await?;
        if logs.contains(secrets.postgres_password()) { return Err(problem("runtime logs were not redacted")); }
        Ok::<_, LocalBackendError>(())
    }.await;

    // Remove only this unique project's containers and explicitly test-owned volume.
    // Marking it non-external lets Compose remove it without touching other volumes.
    let mut cleanup = paths.load_state().ok().flatten().unwrap_or(state);
    cleanup.postgres_volume_initialized = false;
    let cleanup_result = manager
        .runtime
        .stack(
            manager.runtime.compose(
                &paths,
                &cleanup,
                "remove Podman smoke resources",
                ["down", "--volumes", "--remove-orphans"],
            ),
            &secrets,
        )
        .await;
    cleanup_result.expect("clean up only this test's project");
    result.expect("Podman provisioning/reopen/update smoke test");
}
