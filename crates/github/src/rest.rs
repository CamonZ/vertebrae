//! REST writes (Actions re-run and cancel). Reads go through GraphQL.

use crate::{
    client::{map_transport_error, read_checked_response},
    GitHubClient, GitHubError, GitHubToken,
};
use reqwest::header::AUTHORIZATION;

impl GitHubClient {
    /// `segments` are percent-encoded individually, so owner, repository and
    /// ref names can never change the path structure.
    fn rest_url(&self, segments: &[&str], query: &[(&str, &str)]) -> Result<url::Url, GitHubError> {
        let mut url = self.base_url.clone();
        url.path_segments_mut()
            .map_err(|()| GitHubError::InvalidInput {
                message: "GitHub API base URL cannot carry a path".into(),
            })?
            .pop_if_empty()
            .extend(segments);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        Ok(url)
    }

    /// POST without a body; any 2xx counts as accepted.
    pub(crate) async fn rest_post_empty(
        &self,
        token: &GitHubToken,
        segments: &[&str],
    ) -> Result<(), GitHubError> {
        let url = self.rest_url(segments, &[])?;
        let response = self
            .http
            .post(url)
            .header(AUTHORIZATION, format!("Bearer {}", token.expose()))
            .send()
            .await
            .map_err(map_transport_error)?;
        read_checked_response(response).await.map(|_| ())
    }
}
