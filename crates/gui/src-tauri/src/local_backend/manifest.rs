use serde::Deserialize;

use super::state::{
    is_valid_backend_image_ref, BackendImageChannel, LocalBackendError, ManagedStackState,
};

const DEFAULT_MANIFEST_BASE_URL: &str = "https://github.com/CamonZ/sacrum/releases/download";
const MANIFEST_MAX_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub(crate) struct BackendManifest {
    pub schema: u32,
    pub channel: String,
    pub version: String,
    pub build: String,
    pub image_ref: String,
    pub platforms: Vec<String>,
    #[serde(default)]
    pub generated_at: Option<String>,
}

impl BackendManifest {
    pub(crate) fn requires_image_update(&self, state: &ManagedStackState) -> bool {
        self.image_ref != state.sacrum_image_ref
    }

    fn validate(&self, expected_channel: BackendImageChannel) -> Result<(), LocalBackendError> {
        if self.schema != 1 {
            return Err(LocalBackendError::BackendManifestInvalid(format!(
                "unsupported schema {}",
                self.schema
            )));
        }
        if self.channel != expected_channel.manifest_channel() {
            return Err(LocalBackendError::BackendManifestInvalid(format!(
                "expected channel {}, got {}",
                expected_channel.manifest_channel(),
                self.channel
            )));
        }
        if self.version.trim().is_empty() || self.build.trim().is_empty() {
            return Err(LocalBackendError::BackendManifestInvalid(
                "version and build are required".to_string(),
            ));
        }
        if !is_valid_backend_image_ref(&self.image_ref) {
            return Err(LocalBackendError::BackendManifestInvalid(
                "image_ref must be the official digest-pinned image".to_string(),
            ));
        }
        if self.platforms.is_empty()
            || self
                .platforms
                .iter()
                .any(|platform| platform.trim().is_empty())
        {
            return Err(LocalBackendError::BackendManifestInvalid(
                "platforms must contain at least one non-empty platform".to_string(),
            ));
        }
        Ok(())
    }
}

pub(crate) struct BackendManifestClient {
    client: reqwest::Client,
    base_url: String,
}

impl Default for BackendManifestClient {
    fn default() -> Self {
        Self::new(DEFAULT_MANIFEST_BASE_URL)
    }
}

impl BackendManifestClient {
    pub(crate) fn new(base_url: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    pub(crate) async fn fetch(
        &self,
        channel: BackendImageChannel,
    ) -> Result<BackendManifest, LocalBackendError> {
        let url = format!(
            "{}/backend-{}/latest.json",
            self.base_url,
            channel.manifest_channel()
        );
        let response = self.client.get(&url).send().await.map_err(|error| {
            LocalBackendError::BackendManifestFetch {
                url: url.clone(),
                reason: error.to_string(),
            }
        })?;
        let status = response.status();
        if !status.is_success() {
            return Err(LocalBackendError::BackendManifestFetch {
                url,
                reason: format!("server returned HTTP {status}"),
            });
        }
        let bytes =
            response
                .bytes()
                .await
                .map_err(|error| LocalBackendError::BackendManifestFetch {
                    url: url.clone(),
                    reason: error.to_string(),
                })?;
        if bytes.len() > MANIFEST_MAX_BYTES {
            return Err(LocalBackendError::BackendManifestInvalid(format!(
                "response exceeds {MANIFEST_MAX_BYTES} bytes"
            )));
        }
        let manifest: BackendManifest = serde_json::from_slice(&bytes).map_err(|error| {
            LocalBackendError::BackendManifestInvalid(format!("could not parse JSON: {error}"))
        })?;
        manifest.validate(channel)?;
        Ok(manifest)
    }
}

#[cfg(test)]
mod tests {
    use super::super::compose::test_support::{docker_target, DIGEST_IMAGE};
    use super::super::state::{BackendImageChannel, ManagedStackState};
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn manifest_json(channel: &str, image_ref: &str) -> serde_json::Value {
        serde_json::json!({
            "schema": 1,
            "channel": channel,
            "version": "0.4.0",
            "build": "abcdef12",
            "commit": "abcdef1234567890",
            "image": "ghcr.io/camonz/sacrum",
            "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "image_ref": image_ref,
            "platforms": ["linux/amd64", "linux/arm64/v8"],
            "generated_at": "2026-08-21T00:00:00Z"
        })
    }

    #[tokio::test]
    async fn fetches_and_validates_the_channel_manifest() {
        let server = MockServer::start().await;
        let image_ref = format!("{DIGEST_IMAGE}");
        Mock::given(method("GET"))
            .and(path("/backend-master/latest.json"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(manifest_json("master", &image_ref)),
            )
            .mount(&server)
            .await;

        let manifest = BackendManifestClient::new(server.uri())
            .fetch(BackendImageChannel::BackendMaster)
            .await
            .expect("manifest should load");

        assert_eq!(manifest.channel, "master");
        assert_eq!(manifest.image_ref, image_ref);
        assert_eq!(manifest.platforms, ["linux/amd64", "linux/arm64/v8"]);
        assert_eq!(
            manifest.generated_at.as_deref(),
            Some("2026-08-21T00:00:00Z")
        );
    }

    #[tokio::test]
    async fn rejects_a_manifest_for_the_wrong_channel() {
        let server = MockServer::start().await;
        let image_ref = format!("{DIGEST_IMAGE}");
        Mock::given(method("GET"))
            .and(path("/backend-release/latest.json"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(manifest_json("master", &image_ref)),
            )
            .mount(&server)
            .await;

        let error = BackendManifestClient::new(server.uri())
            .fetch(BackendImageChannel::BackendRelease)
            .await
            .expect_err("wrong channel must fail");

        assert!(
            matches!(error, LocalBackendError::BackendManifestInvalid(message) if message.contains("expected channel release"))
        );
    }

    #[test]
    fn compares_the_published_digest_with_local_state() {
        let state = ManagedStackState::fresh(
            DIGEST_IMAGE,
            4400,
            BackendImageChannel::BackendMaster,
            docker_target(),
        )
        .expect("valid state");
        let manifest: BackendManifest = serde_json::from_value(manifest_json(
            "master",
            "ghcr.io/camonz/sacrum@sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
        ))
        .expect("valid manifest");

        assert!(manifest.requires_image_update(&state));
        let same_manifest: BackendManifest =
            serde_json::from_value(manifest_json("master", DIGEST_IMAGE)).expect("valid manifest");
        assert!(!same_manifest.requires_image_update(&state));
    }
}
