use std::collections::BTreeMap;

use futures_util::StreamExt;
use reqwest::{Client, header};
use serde_json::from_slice;

use crate::{
    SystemOneRequest, SystemOneResponse, TypeSafeClientConfig, TypeSafeError,
    error::{redacted_decode_error, status_message},
    validate_response,
};

#[derive(Clone)]
pub struct TypeSafeClient {
    client: Client,
    endpoint: String,
    config: TypeSafeClientConfig,
}

impl std::fmt::Debug for TypeSafeClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TypeSafeClient")
            .field("endpoint", &self.endpoint)
            .field("config", &self.config)
            .finish()
    }
}

impl TypeSafeClient {
    pub fn new(api_key: impl Into<String>) -> Result<Self, TypeSafeError> {
        Self::from_config(TypeSafeClientConfig::new(api_key))
    }

    pub fn from_config(config: TypeSafeClientConfig) -> Result<Self, TypeSafeError> {
        let endpoint = config.endpoint()?;
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(TypeSafeError::Transport)?;

        Ok(Self {
            client,
            endpoint,
            config,
        })
    }

    pub fn config(&self) -> &TypeSafeClientConfig {
        &self.config
    }

    pub async fn system_one(
        &self,
        request: SystemOneRequest,
    ) -> Result<SystemOneResponse, TypeSafeError> {
        request.validate()?;
        let body = serde_json::to_vec(&request).map_err(TypeSafeError::RequestSerialization)?;
        let response = match tokio::time::timeout(self.config.timeout, self.send_once(&body)).await
        {
            Ok(result) => result?,
            Err(_) => {
                return Err(TypeSafeError::Timeout {
                    timeout: self.config.timeout,
                });
            }
        };
        validate_response(&request, &response)?;
        Ok(response)
    }

    pub async fn evaluate(
        &self,
        state: impl Into<crate::SystemOneState>,
        model: impl Into<String>,
        questions: BTreeMap<String, crate::Question>,
    ) -> Result<SystemOneResponse, TypeSafeError> {
        self.system_one(SystemOneRequest::for_model(state, model, questions))
            .await
    }

    async fn send_once(&self, body: &[u8]) -> Result<SystemOneResponse, TypeSafeError> {
        let response = self
            .client
            .post(&self.endpoint)
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", self.config.api_key()),
            )
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.to_owned())
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    TypeSafeError::Timeout {
                        timeout: self.config.timeout,
                    }
                } else {
                    TypeSafeError::Transport(error)
                }
            })?;

        let request_id = response
            .headers()
            .get("x-typesafe-request-id")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let status = response.status();
        let bytes = read_bounded_body(response, self.config.max_response_bytes).await?;

        if !status.is_success() {
            return Err(TypeSafeError::ApiError {
                status: status.as_u16(),
                message: status_message(status).to_string(),
                request_id,
            });
        }

        let mut response: SystemOneResponse = from_slice(&bytes)
            .map_err(|error| TypeSafeError::MalformedResponse(redacted_decode_error(&error)))?;
        response.request_id = (!request_id.is_empty()).then_some(request_id);
        Ok(response)
    }
}

async fn read_bounded_body(
    response: reqwest::Response,
    max_response_bytes: usize,
) -> Result<Vec<u8>, TypeSafeError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_response_bytes as u64)
    {
        return Err(TypeSafeError::ResponseTooLarge);
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(TypeSafeError::Transport)?;
        if body.len().saturating_add(chunk.len()) > max_response_bytes {
            return Err(TypeSafeError::ResponseTooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
