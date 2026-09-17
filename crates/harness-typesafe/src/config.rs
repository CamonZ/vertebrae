use std::{fmt, time::Duration};

use reqwest::Url;

use crate::error::TypeSafeError;

pub const DEFAULT_BASE_URL: &str = "https://api.typesafe.ai";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// API keys are redacted from `Debug` output.
#[derive(Clone)]
pub struct TypeSafeClientConfig {
    api_key: String,
    pub base_url: String,
    pub timeout: Duration,
    pub max_response_bytes: usize,
}

impl fmt::Debug for TypeSafeClientConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TypeSafeClientConfig")
            .field("api_key", &"[REDACTED]")
            .field("base_url", &self.base_url)
            .field("timeout", &self.timeout)
            .field("max_response_bytes", &self.max_response_bytes)
            .finish()
    }
}

impl TypeSafeClientConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: DEFAULT_BASE_URL.to_string(),
            timeout: DEFAULT_TIMEOUT,
            max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
        }
    }

    pub fn with_api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = api_key.into();
        self
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_max_response_bytes(mut self, max_response_bytes: usize) -> Self {
        self.max_response_bytes = max_response_bytes;
        self
    }

    pub(crate) fn endpoint(&self) -> Result<String, TypeSafeError> {
        if self.api_key.trim().is_empty() {
            return Err(TypeSafeError::MissingApiKey);
        }
        if self.timeout.is_zero() {
            return Err(invalid_configuration("timeout must be greater than zero"));
        }
        if self.max_response_bytes == 0 {
            return Err(invalid_configuration(
                "max_response_bytes must be greater than zero",
            ));
        }

        let base_url = Url::parse(&self.base_url)
            .map_err(|_| invalid_configuration("base_url must be a valid URL"))?;
        if !matches!(base_url.scheme(), "http" | "https")
            || base_url.host_str().is_none()
            || !base_url.username().is_empty()
            || base_url.password().is_some()
            || base_url.query().is_some()
            || base_url.fragment().is_some()
        {
            return Err(invalid_configuration(
                "base_url must use HTTP(S) without credentials, query, or fragment",
            ));
        }

        Ok(format!(
            "{}/v1/systemone",
            self.base_url.trim_end_matches('/')
        ))
    }

    pub(crate) fn api_key(&self) -> &str {
        &self.api_key
    }
}

impl Default for TypeSafeClientConfig {
    fn default() -> Self {
        Self::new(String::new())
    }
}

fn invalid_configuration(message: impl Into<String>) -> TypeSafeError {
    TypeSafeError::InvalidConfiguration(message.into())
}
