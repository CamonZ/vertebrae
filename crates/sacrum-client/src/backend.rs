//! Pure startup policy for selecting the configured Sacrum backend.

use crate::config::{
    BackendMode, BackendReleaseChannel, EffectiveSacrumConnection, GlobalSacrumSection,
    LocalBackendSection, LocalProvisioningState, RuntimeSecretsSource,
};
use sha2::{Digest, Sha256};
use std::fmt;
use std::net::IpAddr;
use thiserror::Error;

/// Compose project created by `scripts/dev-backend.sh`.
pub const LEGACY_DEV_COMPOSE_PROJECT: &str = "vertebrae-dev";
/// PostgreSQL volume created by `scripts/dev-backend.sh`.
pub const LEGACY_DEV_DATABASE_VOLUME: &str = "vertebrae-dev_pgdata";
/// Only Sacrum image repository accepted for managed local backends.
pub const SACRUM_IMAGE_REPOSITORY: &str = "ghcr.io/camonz/sacrum";

/// Result of evaluating persisted ownership, effective connection values, and
/// verified Docker evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendStartupDecision {
    /// Connect to the configured backend without invoking Docker.
    ConnectRemote,
    /// Inspect and ensure the configured local Docker stack, resuming the
    /// observed provisioning state where necessary.
    EnsureLocal {
        provisioning_state: LocalProvisioningState,
    },
    /// Ask the user whether to adopt the verified `dev-backend.sh` stack.
    OfferLegacyDevStackAdoption,
    /// Backend selection or required metadata is missing or unsafe.
    SetupRequired(BackendSetupIssue),
}

/// Diagnosable reason that backend setup cannot proceed automatically.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendSetupIssue {
    /// No explicit backend ownership mode has been saved and no adoptable stack
    /// was verified.
    MissingMode,
    /// The selected mode has missing or invalid fields.
    InvalidConfiguration {
        mode: BackendMode,
        problems: Vec<BackendConfigProblem>,
    },
    /// Docker evidence was present, but the current connection cannot safely be
    /// associated with it.
    LegacyAdoptionUnavailable { problems: Vec<BackendConfigProblem> },
    /// One or more lifecycle values were written by a newer client.
    UnsupportedConfiguration { problems: Vec<BackendConfigProblem> },
}

/// Missing or invalid backend configuration detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendConfigProblem {
    Missing(BackendConfigField),
    InvalidLocalEndpoint,
    LegacyEndpointMismatch,
    InvalidOfficialImageReference,
    ManagedSecretsPathNotAbsolute,
    InvalidLegacyRuntimeSecretsIdentity,
    LegacyAuthenticatedTokenMismatch,
    UnsupportedValue {
        field: BackendConfigField,
        value: String,
    },
}

/// Required backend configuration field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendConfigField {
    Mode,
    Url,
    Token,
    LocalSection,
    ComposeProject,
    DatabaseVolume,
    Channel,
    ImageReference,
    ProvisioningState,
    RuntimeSecrets,
}

/// Docker identity that a lifecycle component has already inspected.
///
/// Construction validates the exact project and volume used by
/// `scripts/dev-backend.sh`, the observed loopback HTTP(S) endpoint, an
/// official immutable image digest, and the token used by a successful
/// authenticated probe. A localhost URL from configuration is not Docker
/// evidence.
#[derive(Clone, PartialEq, Eq)]
pub struct VerifiedLegacyDevStack {
    backend_endpoint: String,
    image_ref: String,
    authenticated_token_fingerprint: [u8; 32],
}

impl fmt::Debug for VerifiedLegacyDevStack {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VerifiedLegacyDevStack")
            .field("backend_endpoint", &self.backend_endpoint)
            .field("image_ref", &self.image_ref)
            .field("authenticated", &true)
            .finish()
    }
}

impl VerifiedLegacyDevStack {
    /// Validate metadata from an externally performed authenticated probe.
    ///
    /// Callers must only construct this value after the inspected container
    /// answered successfully using `authenticated_token`. Only an opaque
    /// fingerprint is retained, and it is omitted from `Debug` output.
    pub fn from_authenticated_probe(
        compose_project: &str,
        database_volume: &str,
        backend_endpoint: &str,
        image_ref: &str,
        authenticated_token: &str,
    ) -> Result<Self, LegacyDevStackEvidenceError> {
        if compose_project != LEGACY_DEV_COMPOSE_PROJECT {
            return Err(LegacyDevStackEvidenceError::UnexpectedComposeProject);
        }
        if database_volume != LEGACY_DEV_DATABASE_VOLUME {
            return Err(LegacyDevStackEvidenceError::UnexpectedDatabaseVolume);
        }
        let endpoint = parse_http_endpoint(backend_endpoint)
            .ok_or(LegacyDevStackEvidenceError::InvalidBackendEndpoint)?;
        if !is_loopback_http_endpoint(backend_endpoint) {
            return Err(LegacyDevStackEvidenceError::InvalidBackendEndpoint);
        }
        if !is_digest_pinned_image_ref(image_ref) {
            return Err(LegacyDevStackEvidenceError::InvalidImageReference);
        }
        if authenticated_token.trim().is_empty() {
            return Err(LegacyDevStackEvidenceError::MissingAuthenticatedToken);
        }
        Ok(Self {
            backend_endpoint: endpoint.to_string(),
            image_ref: image_ref.to_string(),
            authenticated_token_fingerprint: token_fingerprint(authenticated_token),
        })
    }

    /// Exact Compose project identity.
    pub fn compose_project(&self) -> &'static str {
        LEGACY_DEV_COMPOSE_PROJECT
    }

    /// Exact persistent database volume identity.
    pub fn database_volume(&self) -> &'static str {
        LEGACY_DEV_DATABASE_VOLUME
    }

    /// Normalized externally observed backend endpoint.
    pub fn backend_endpoint(&self) -> &str {
        &self.backend_endpoint
    }

    /// Immutable externally observed Sacrum image reference.
    pub fn image_ref(&self) -> &str {
        &self.image_ref
    }

    fn matches_authenticated_token(&self, token: &str) -> bool {
        self.authenticated_token_fingerprint == token_fingerprint(token)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum LegacyDevStackEvidenceError {
    #[error("Docker Compose project is not the scripts/dev-backend.sh project")]
    UnexpectedComposeProject,
    #[error("PostgreSQL volume is not the scripts/dev-backend.sh volume")]
    UnexpectedDatabaseVolume,
    #[error("the observed backend endpoint is not a valid HTTP(S) URL")]
    InvalidBackendEndpoint,
    #[error("the inspected Sacrum image is not an official lowercase SHA-256 digest reference")]
    InvalidImageReference,
    #[error("the authenticated probe did not use a usable API token")]
    MissingAuthenticatedToken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum LegacyDevStackAdoptionError {
    #[error("the user must confirm legacy stack adoption")]
    ConfirmationRequired,
    #[error("backend mode is already configured")]
    BackendAlreadyConfigured,
    #[error("the verified stack does not match the persisted Sacrum connection")]
    AdoptionNotOffered,
}

/// Determine what GUI startup should do without performing I/O.
///
/// The caller resolves environment precedence into `connection`. The policy
/// reads ownership only from `sacrum.mode`, so overrides cannot change it.
pub fn backend_startup_decision(
    sacrum: &GlobalSacrumSection,
    connection: &EffectiveSacrumConnection,
    legacy_stack: Option<&VerifiedLegacyDevStack>,
) -> BackendStartupDecision {
    match sacrum.mode.as_ref() {
        None => decision_for_mode_less(sacrum, legacy_stack),
        Some(BackendMode::Remote) => decision_for_remote(connection),
        Some(BackendMode::Local) => decision_for_local(sacrum, connection),
        Some(BackendMode::Unsupported(value)) => {
            BackendStartupDecision::SetupRequired(BackendSetupIssue::UnsupportedConfiguration {
                problems: vec![BackendConfigProblem::UnsupportedValue {
                    field: BackendConfigField::Mode,
                    value: value.clone(),
                }],
            })
        }
    }
}

fn decision_for_mode_less(
    sacrum: &GlobalSacrumSection,
    legacy_stack: Option<&VerifiedLegacyDevStack>,
) -> BackendStartupDecision {
    let Some(legacy_stack) = legacy_stack else {
        return BackendStartupDecision::SetupRequired(BackendSetupIssue::MissingMode);
    };

    let persisted = EffectiveSacrumConnection::from_persisted(sacrum);
    let mut problems = missing_connection_problems(&persisted);
    if !persisted.url.trim().is_empty()
        && !endpoints_match(&persisted.url, legacy_stack.backend_endpoint())
    {
        problems.push(BackendConfigProblem::LegacyEndpointMismatch);
    }
    if let Some(token) = persisted
        .token
        .as_deref()
        .filter(|token| !token.trim().is_empty())
        && !legacy_stack.matches_authenticated_token(token)
    {
        problems.push(BackendConfigProblem::LegacyAuthenticatedTokenMismatch);
    }

    if problems.is_empty() {
        BackendStartupDecision::OfferLegacyDevStackAdoption
    } else {
        BackendStartupDecision::SetupRequired(BackendSetupIssue::LegacyAdoptionUnavailable {
            problems,
        })
    }
}

fn decision_for_remote(connection: &EffectiveSacrumConnection) -> BackendStartupDecision {
    let problems = missing_connection_problems(connection);
    if problems.is_empty() {
        BackendStartupDecision::ConnectRemote
    } else {
        invalid(BackendMode::Remote, problems)
    }
}

fn decision_for_local(
    sacrum: &GlobalSacrumSection,
    connection: &EffectiveSacrumConnection,
) -> BackendStartupDecision {
    let mut problems = missing_connection_problems(connection);
    if !connection.url.trim().is_empty() && !is_loopback_http_endpoint(&connection.url) {
        problems.push(BackendConfigProblem::InvalidLocalEndpoint);
    }

    let Some(local) = sacrum.local.as_ref() else {
        problems.push(BackendConfigProblem::Missing(
            BackendConfigField::LocalSection,
        ));
        return invalid(BackendMode::Local, problems);
    };

    if local.compose_project.trim().is_empty() {
        problems.push(BackendConfigProblem::Missing(
            BackendConfigField::ComposeProject,
        ));
    }
    if local.database_volume.trim().is_empty() {
        problems.push(BackendConfigProblem::Missing(
            BackendConfigField::DatabaseVolume,
        ));
    }
    match local.channel.as_ref() {
        None => problems.push(BackendConfigProblem::Missing(BackendConfigField::Channel)),
        Some(BackendReleaseChannel::Unsupported(value)) => {
            problems.push(BackendConfigProblem::UnsupportedValue {
                field: BackendConfigField::Channel,
                value: value.clone(),
            });
        }
        Some(BackendReleaseChannel::Master | BackendReleaseChannel::Release) => {}
    }
    if local.image_ref.trim().is_empty() {
        problems.push(BackendConfigProblem::Missing(
            BackendConfigField::ImageReference,
        ));
    } else if !is_digest_pinned_image_ref(&local.image_ref) {
        problems.push(BackendConfigProblem::InvalidOfficialImageReference);
    }
    let provisioning_state = match local.provisioning_state.as_ref() {
        Some(LocalProvisioningState::Unsupported(value)) => {
            problems.push(BackendConfigProblem::UnsupportedValue {
                field: BackendConfigField::ProvisioningState,
                value: value.clone(),
            });
            None
        }
        Some(state) => Some(state.clone()),
        None => {
            problems.push(BackendConfigProblem::Missing(
                BackendConfigField::ProvisioningState,
            ));
            None
        }
    };
    validate_runtime_secrets(local, &mut problems);

    if problems.is_empty() {
        BackendStartupDecision::EnsureLocal {
            provisioning_state: provisioning_state.expect("validated provisioning state"),
        }
    } else {
        invalid(BackendMode::Local, problems)
    }
}

fn missing_connection_problems(
    connection: &EffectiveSacrumConnection,
) -> Vec<BackendConfigProblem> {
    let mut problems = Vec::new();
    if connection.url.trim().is_empty() {
        problems.push(BackendConfigProblem::Missing(BackendConfigField::Url));
    }
    if connection
        .token
        .as_deref()
        .is_none_or(|token| token.trim().is_empty())
    {
        problems.push(BackendConfigProblem::Missing(BackendConfigField::Token));
    }
    problems
}

fn validate_runtime_secrets(local: &LocalBackendSection, problems: &mut Vec<BackendConfigProblem>) {
    match local.runtime_secrets.as_ref() {
        Some(RuntimeSecretsSource::ManagedFile { path }) if !path.is_absolute() => {
            problems.push(BackendConfigProblem::ManagedSecretsPathNotAbsolute);
        }
        Some(RuntimeSecretsSource::ManagedFile { .. }) => {}
        Some(RuntimeSecretsSource::LegacyDevCompose)
            if local.compose_project != LEGACY_DEV_COMPOSE_PROJECT
                || local.database_volume != LEGACY_DEV_DATABASE_VOLUME =>
        {
            problems.push(BackendConfigProblem::InvalidLegacyRuntimeSecretsIdentity);
        }
        Some(RuntimeSecretsSource::LegacyDevCompose) => {}
        Some(RuntimeSecretsSource::Unsupported { kind, .. }) => {
            problems.push(BackendConfigProblem::UnsupportedValue {
                field: BackendConfigField::RuntimeSecrets,
                value: kind.clone().unwrap_or_else(|| "<missing kind>".to_string()),
            });
        }
        None => problems.push(BackendConfigProblem::Missing(
            BackendConfigField::RuntimeSecrets,
        )),
    }
}

fn invalid(mode: BackendMode, problems: Vec<BackendConfigProblem>) -> BackendStartupDecision {
    if problems
        .iter()
        .any(|problem| matches!(problem, BackendConfigProblem::UnsupportedValue { .. }))
    {
        BackendStartupDecision::SetupRequired(BackendSetupIssue::UnsupportedConfiguration {
            problems,
        })
    } else {
        BackendStartupDecision::SetupRequired(BackendSetupIssue::InvalidConfiguration {
            mode,
            problems,
        })
    }
}

fn parse_http_endpoint(value: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(value).ok()?;
    if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() {
        Some(url)
    } else {
        None
    }
}

fn endpoints_match(configured: &str, observed: &str) -> bool {
    match (
        parse_http_endpoint(configured),
        parse_http_endpoint(observed),
    ) {
        (Some(configured), Some(observed)) => configured == observed,
        _ => false,
    }
}

fn is_loopback_http_endpoint(value: &str) -> bool {
    let Some(url) = parse_http_endpoint(value) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.trim_matches(['[', ']'])
        .parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback())
}

fn is_digest_pinned_image_ref(image_ref: &str) -> bool {
    let Some(digest) = image_ref.strip_prefix(&format!("{SACRUM_IMAGE_REPOSITORY}@sha256:")) else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn token_fingerprint(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

/// Persist explicit local ownership after the user confirms adoption.
pub fn adopt_legacy_dev_stack(
    sacrum: &mut GlobalSacrumSection,
    connection: &EffectiveSacrumConnection,
    evidence: &VerifiedLegacyDevStack,
    user_confirmed: bool,
) -> Result<(), LegacyDevStackAdoptionError> {
    if !user_confirmed {
        return Err(LegacyDevStackAdoptionError::ConfirmationRequired);
    }
    if sacrum.mode.is_some() {
        return Err(LegacyDevStackAdoptionError::BackendAlreadyConfigured);
    }
    if backend_startup_decision(sacrum, connection, Some(evidence))
        != BackendStartupDecision::OfferLegacyDevStackAdoption
    {
        return Err(LegacyDevStackAdoptionError::AdoptionNotOffered);
    }

    sacrum.mode = Some(BackendMode::Local);
    sacrum.local = Some(LocalBackendSection {
        compose_project: evidence.compose_project().to_string(),
        database_volume: evidence.database_volume().to_string(),
        channel: Some(BackendReleaseChannel::Master),
        image_ref: evidence.image_ref().to_string(),
        provisioning_state: Some(LocalProvisioningState::Ready),
        runtime_secrets: Some(RuntimeSecretsSource::LegacyDevCompose),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const DIGEST: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn digest_image() -> String {
        format!("ghcr.io/camonz/sacrum@sha256:{DIGEST}")
    }

    fn persisted_connection(sacrum: &GlobalSacrumSection) -> EffectiveSacrumConnection {
        EffectiveSacrumConnection::from_persisted(sacrum)
    }

    fn remote_section() -> GlobalSacrumSection {
        GlobalSacrumSection {
            mode: Some(BackendMode::Remote),
            url: "https://sacrum.example.test".to_string(),
            token: Some("sac_remote-token".to_string()),
            local: None,
        }
    }

    fn managed_local_section(state: LocalProvisioningState) -> GlobalSacrumSection {
        GlobalSacrumSection {
            mode: Some(BackendMode::Local),
            url: "http://localhost:4400".to_string(),
            token: Some("sac_generated-token".to_string()),
            local: Some(LocalBackendSection {
                compose_project: "vertebrae-local".to_string(),
                database_volume: "vertebrae-local_pgdata".to_string(),
                channel: Some(BackendReleaseChannel::Release),
                image_ref: digest_image(),
                provisioning_state: Some(state),
                runtime_secrets: Some(RuntimeSecretsSource::ManagedFile {
                    path: PathBuf::from("/config/vertebrae/local-backend.env"),
                }),
            }),
        }
    }

    fn legacy_evidence(token: &str) -> VerifiedLegacyDevStack {
        VerifiedLegacyDevStack::from_authenticated_probe(
            LEGACY_DEV_COMPOSE_PROJECT,
            LEGACY_DEV_DATABASE_VOLUME,
            "http://localhost:4400",
            &digest_image(),
            token,
        )
        .unwrap()
    }

    #[test]
    fn explicit_remote_connects_without_considering_local_evidence() {
        let section = remote_section();
        assert_eq!(
            backend_startup_decision(
                &section,
                &persisted_connection(&section),
                Some(&legacy_evidence("probe-token"))
            ),
            BackendStartupDecision::ConnectRemote
        );
    }

    #[test]
    fn effective_token_completes_connection_without_changing_remote_ownership() {
        let mut section = remote_section();
        section.token = None;
        let effective =
            EffectiveSacrumConnection::new(section.url.clone(), Some("sac_env-token".to_string()));

        assert_eq!(
            backend_startup_decision(&section, &effective, None),
            BackendStartupDecision::ConnectRemote
        );
        assert_eq!(section.mode, Some(BackendMode::Remote));
        assert!(section.token.is_none());
    }

    #[test]
    fn local_decision_preserves_every_provisioning_state() {
        for state in [
            LocalProvisioningState::Pending,
            LocalProvisioningState::InProgress,
            LocalProvisioningState::Ready,
            LocalProvisioningState::Failed,
        ] {
            let section = managed_local_section(state.clone());
            assert_eq!(
                backend_startup_decision(&section, &persisted_connection(&section), None),
                BackendStartupDecision::EnsureLocal {
                    provisioning_state: state
                }
            );
        }
    }

    #[test]
    fn mode_less_localhost_requires_setup_without_verified_docker_evidence() {
        let section = GlobalSacrumSection {
            url: "http://localhost:4400".to_string(),
            token: Some("sac_dev-local-token".to_string()),
            ..Default::default()
        };
        assert_eq!(
            backend_startup_decision(&section, &persisted_connection(&section), None),
            BackendStartupDecision::SetupRequired(BackendSetupIssue::MissingMode)
        );
    }

    #[test]
    fn verified_legacy_identity_endpoint_token_and_digest_are_offered_for_adoption() {
        let section = GlobalSacrumSection {
            url: "http://localhost:4400".to_string(),
            token: Some("sac_dev-local-token".to_string()),
            ..Default::default()
        };
        assert_eq!(
            backend_startup_decision(
                &section,
                &persisted_connection(&section),
                Some(&legacy_evidence("sac_dev-local-token"))
            ),
            BackendStartupDecision::OfferLegacyDevStackAdoption
        );
    }

    #[test]
    fn legacy_evidence_rejects_near_matches_invalid_endpoint_and_mutable_image() {
        assert_eq!(
            VerifiedLegacyDevStack::from_authenticated_probe(
                "some-local-project",
                LEGACY_DEV_DATABASE_VOLUME,
                "http://localhost:4400",
                &digest_image(),
                "token"
            ),
            Err(LegacyDevStackEvidenceError::UnexpectedComposeProject)
        );
        assert_eq!(
            VerifiedLegacyDevStack::from_authenticated_probe(
                LEGACY_DEV_COMPOSE_PROJECT,
                "some_pgdata",
                "http://localhost:4400",
                &digest_image(),
                "token"
            ),
            Err(LegacyDevStackEvidenceError::UnexpectedDatabaseVolume)
        );
        assert_eq!(
            VerifiedLegacyDevStack::from_authenticated_probe(
                LEGACY_DEV_COMPOSE_PROJECT,
                LEGACY_DEV_DATABASE_VOLUME,
                "not a URL",
                &digest_image(),
                "token"
            ),
            Err(LegacyDevStackEvidenceError::InvalidBackendEndpoint)
        );
        assert_eq!(
            VerifiedLegacyDevStack::from_authenticated_probe(
                LEGACY_DEV_COMPOSE_PROJECT,
                LEGACY_DEV_DATABASE_VOLUME,
                "https://sacrum.example.test",
                &digest_image(),
                "token"
            ),
            Err(LegacyDevStackEvidenceError::InvalidBackendEndpoint)
        );
        assert_eq!(
            VerifiedLegacyDevStack::from_authenticated_probe(
                LEGACY_DEV_COMPOSE_PROJECT,
                LEGACY_DEV_DATABASE_VOLUME,
                "http://localhost:4400",
                "ghcr.io/camonz/sacrum:latest",
                "token"
            ),
            Err(LegacyDevStackEvidenceError::InvalidImageReference)
        );
        assert_eq!(
            VerifiedLegacyDevStack::from_authenticated_probe(
                LEGACY_DEV_COMPOSE_PROJECT,
                LEGACY_DEV_DATABASE_VOLUME,
                "http://localhost:4400",
                &digest_image(),
                "  "
            ),
            Err(LegacyDevStackEvidenceError::MissingAuthenticatedToken)
        );
    }

    #[test]
    fn legacy_endpoint_mismatch_is_diagnosable_and_not_offered() {
        let section = GlobalSacrumSection {
            url: "http://localhost:4500".to_string(),
            token: Some("sac_token".to_string()),
            ..Default::default()
        };
        assert_eq!(
            backend_startup_decision(
                &section,
                &persisted_connection(&section),
                Some(&legacy_evidence("sac_token"))
            ),
            BackendStartupDecision::SetupRequired(BackendSetupIssue::LegacyAdoptionUnavailable {
                problems: vec![BackendConfigProblem::LegacyEndpointMismatch]
            })
        );
    }

    #[test]
    fn empty_mode_less_connection_with_evidence_is_not_offered() {
        let section = GlobalSacrumSection {
            url: String::new(),
            ..Default::default()
        };
        assert_eq!(
            backend_startup_decision(
                &section,
                &persisted_connection(&section),
                Some(&legacy_evidence("unused-token"))
            ),
            BackendStartupDecision::SetupRequired(BackendSetupIssue::LegacyAdoptionUnavailable {
                problems: vec![
                    BackendConfigProblem::Missing(BackendConfigField::Url),
                    BackendConfigProblem::Missing(BackendConfigField::Token),
                ]
            })
        );
    }

    #[test]
    fn env_only_connection_cannot_adopt_into_incomplete_persisted_config() {
        let mut section = GlobalSacrumSection {
            url: "http://localhost:4400".to_string(),
            token: None,
            ..Default::default()
        };
        let effective = EffectiveSacrumConnection::new(
            "http://localhost:4400",
            Some("sac_env-token".to_string()),
        );
        let evidence = legacy_evidence("sac_env-token");

        assert_eq!(
            backend_startup_decision(&section, &effective, Some(&evidence)),
            BackendStartupDecision::SetupRequired(BackendSetupIssue::LegacyAdoptionUnavailable {
                problems: vec![BackendConfigProblem::Missing(BackendConfigField::Token)]
            })
        );
        assert_eq!(
            adopt_legacy_dev_stack(&mut section, &effective, &evidence, true),
            Err(LegacyDevStackAdoptionError::AdoptionNotOffered)
        );
        assert_eq!(section.mode, None);
        assert_eq!(section.local, None);
    }

    #[test]
    fn stale_authenticated_token_evidence_is_rejected_without_leaking_tokens() {
        let section = GlobalSacrumSection {
            url: "http://localhost:4400".to_string(),
            token: Some("sac_current-token".to_string()),
            ..Default::default()
        };
        let evidence = legacy_evidence("sac_stale-token");

        assert_eq!(
            backend_startup_decision(&section, &persisted_connection(&section), Some(&evidence)),
            BackendStartupDecision::SetupRequired(BackendSetupIssue::LegacyAdoptionUnavailable {
                problems: vec![BackendConfigProblem::LegacyAuthenticatedTokenMismatch]
            })
        );
        let debug = format!("{evidence:?}");
        assert!(!debug.contains("sac_stale-token"));
        assert!(!debug.contains("sac_current-token"));
        assert!(!debug.contains("authenticated_token_fingerprint"));
    }

    #[test]
    fn official_repository_and_lowercase_digest_are_required() {
        let uppercase_digest = "A".repeat(64);
        let invalid_references = [
            format!("ghcr.io/other/sacrum@sha256:{DIGEST}"),
            format!("{SACRUM_IMAGE_REPOSITORY}@sha256:{uppercase_digest}"),
            format!("{SACRUM_IMAGE_REPOSITORY}@sha256:{}", "g".repeat(64)),
            format!("{SACRUM_IMAGE_REPOSITORY}@sha256:{}", "a".repeat(63)),
        ];

        for image_ref in invalid_references {
            assert_eq!(
                VerifiedLegacyDevStack::from_authenticated_probe(
                    LEGACY_DEV_COMPOSE_PROJECT,
                    LEGACY_DEV_DATABASE_VOLUME,
                    "http://localhost:4400",
                    &image_ref,
                    "token"
                ),
                Err(LegacyDevStackEvidenceError::InvalidImageReference)
            );

            let mut section = managed_local_section(LocalProvisioningState::Ready);
            section.local.as_mut().unwrap().image_ref = image_ref;
            assert!(matches!(
                backend_startup_decision(&section, &persisted_connection(&section), None),
                BackendStartupDecision::SetupRequired(
                    BackendSetupIssue::InvalidConfiguration { ref problems, .. }
                ) if problems.contains(&BackendConfigProblem::InvalidOfficialImageReference)
            ));
        }
    }

    #[test]
    fn adoption_requires_confirmation_and_does_not_mutate_when_declined() {
        let mut section = GlobalSacrumSection {
            url: "http://localhost:4400".to_string(),
            token: Some("sac_existing-token".to_string()),
            ..Default::default()
        };
        let original = section.clone();
        let connection = persisted_connection(&section);
        assert_eq!(
            adopt_legacy_dev_stack(
                &mut section,
                &connection,
                &legacy_evidence("sac_existing-token"),
                false
            ),
            Err(LegacyDevStackAdoptionError::ConfirmationRequired)
        );
        assert_eq!(section, original);
    }

    #[test]
    fn confirmed_adoption_preserves_connection_and_uses_master_channel() {
        let mut section = GlobalSacrumSection {
            url: "http://localhost:4400".to_string(),
            token: Some("sac_existing-token".to_string()),
            ..Default::default()
        };
        let connection = persisted_connection(&section);
        let evidence = legacy_evidence("sac_existing-token");
        adopt_legacy_dev_stack(&mut section, &connection, &evidence, true).unwrap();

        assert_eq!(section.url, "http://localhost:4400");
        assert_eq!(section.token.as_deref(), Some("sac_existing-token"));
        assert_eq!(section.mode, Some(BackendMode::Local));
        let local = section.local.as_ref().unwrap();
        assert_eq!(local.compose_project, LEGACY_DEV_COMPOSE_PROJECT);
        assert_eq!(local.database_volume, LEGACY_DEV_DATABASE_VOLUME);
        assert_eq!(local.channel, Some(BackendReleaseChannel::Master));
        assert_eq!(local.image_ref, digest_image());
        assert_eq!(
            backend_startup_decision(&section, &connection, None),
            BackendStartupDecision::EnsureLocal {
                provisioning_state: LocalProvisioningState::Ready
            }
        );
    }

    #[test]
    fn partial_local_configuration_reports_missing_fields_deterministically() {
        let section = GlobalSacrumSection {
            mode: Some(BackendMode::Local),
            url: String::new(),
            token: Some("  ".to_string()),
            local: Some(LocalBackendSection::default()),
        };
        assert_eq!(
            backend_startup_decision(&section, &persisted_connection(&section), None),
            BackendStartupDecision::SetupRequired(BackendSetupIssue::InvalidConfiguration {
                mode: BackendMode::Local,
                problems: vec![
                    BackendConfigProblem::Missing(BackendConfigField::Url),
                    BackendConfigProblem::Missing(BackendConfigField::Token),
                    BackendConfigProblem::Missing(BackendConfigField::ComposeProject),
                    BackendConfigProblem::Missing(BackendConfigField::DatabaseVolume),
                    BackendConfigProblem::Missing(BackendConfigField::Channel),
                    BackendConfigProblem::Missing(BackendConfigField::ImageReference),
                    BackendConfigProblem::Missing(BackendConfigField::ProvisioningState),
                    BackendConfigProblem::Missing(BackendConfigField::RuntimeSecrets),
                ]
            })
        );
    }

    #[test]
    fn unknown_lifecycle_values_are_diagnosed_as_unsupported() {
        let mode = GlobalSacrumSection {
            mode: Some(BackendMode::Unsupported("federated".to_string())),
            url: "https://sacrum.example.test".to_string(),
            token: Some("token".to_string()),
            local: None,
        };
        assert_eq!(
            backend_startup_decision(&mode, &persisted_connection(&mode), None),
            BackendStartupDecision::SetupRequired(BackendSetupIssue::UnsupportedConfiguration {
                problems: vec![BackendConfigProblem::UnsupportedValue {
                    field: BackendConfigField::Mode,
                    value: "federated".to_string(),
                }]
            })
        );

        let mut local = managed_local_section(LocalProvisioningState::Ready);
        let section = local.local.as_mut().unwrap();
        section.channel = Some(BackendReleaseChannel::Unsupported("canary".to_string()));
        section.provisioning_state =
            Some(LocalProvisioningState::Unsupported("paused".to_string()));
        section.runtime_secrets = Some(RuntimeSecretsSource::Unsupported {
            kind: Some("keychain".to_string()),
            fields: std::collections::BTreeMap::from([(
                "service".to_string(),
                toml::Value::String("vertebrae".to_string()),
            )]),
        });
        assert_eq!(
            backend_startup_decision(&local, &persisted_connection(&local), None),
            BackendStartupDecision::SetupRequired(BackendSetupIssue::UnsupportedConfiguration {
                problems: vec![
                    BackendConfigProblem::UnsupportedValue {
                        field: BackendConfigField::Channel,
                        value: "canary".to_string(),
                    },
                    BackendConfigProblem::UnsupportedValue {
                        field: BackendConfigField::ProvisioningState,
                        value: "paused".to_string(),
                    },
                    BackendConfigProblem::UnsupportedValue {
                        field: BackendConfigField::RuntimeSecrets,
                        value: "keychain".to_string(),
                    },
                ]
            })
        );
    }

    #[test]
    fn managed_local_rejects_relative_secrets_path_and_mutable_image() {
        let mut section = managed_local_section(LocalProvisioningState::Ready);
        let local = section.local.as_mut().unwrap();
        local.image_ref = "ghcr.io/camonz/sacrum:latest".to_string();
        local.runtime_secrets = Some(RuntimeSecretsSource::ManagedFile {
            path: PathBuf::from("relative/local-backend.env"),
        });
        assert_eq!(
            backend_startup_decision(&section, &persisted_connection(&section), None),
            BackendStartupDecision::SetupRequired(BackendSetupIssue::InvalidConfiguration {
                mode: BackendMode::Local,
                problems: vec![
                    BackendConfigProblem::InvalidOfficialImageReference,
                    BackendConfigProblem::ManagedSecretsPathNotAbsolute,
                ]
            })
        );
    }

    #[test]
    fn managed_local_requires_loopback_http_endpoint() {
        for invalid in [
            "https://sacrum.example.test",
            "ftp://localhost:4400",
            "not a URL",
        ] {
            let mut section = managed_local_section(LocalProvisioningState::Ready);
            section.url = invalid.to_string();
            let decision =
                backend_startup_decision(&section, &persisted_connection(&section), None);
            assert!(matches!(
                decision,
                BackendStartupDecision::SetupRequired(
                    BackendSetupIssue::InvalidConfiguration { ref problems, .. }
                ) if problems.contains(&BackendConfigProblem::InvalidLocalEndpoint)
            ));
        }
    }

    #[test]
    fn managed_local_accepts_loopback_host_variants() {
        for valid in [
            "http://localhost:4400",
            "https://127.0.0.1:4400",
            "http://[::1]:4400",
        ] {
            let mut section = managed_local_section(LocalProvisioningState::Pending);
            section.url = valid.to_string();
            assert!(matches!(
                backend_startup_decision(&section, &persisted_connection(&section), None),
                BackendStartupDecision::EnsureLocal { .. }
            ));
        }
    }

    #[test]
    fn release_channels_map_to_expected_metadata_names() {
        assert_eq!(
            BackendReleaseChannel::Master.metadata_name(),
            Some("backend-master")
        );
        assert_eq!(
            BackendReleaseChannel::Release.metadata_name(),
            Some("backend-release")
        );
    }
}
