//! TypeSafe-specific models stay in this crate; provider-neutral translation
//! belongs in the harness adapter boundary.

mod client;
mod config;
mod error;
mod models;
mod validation;

pub use client::TypeSafeClient;
pub use config::{
    DEFAULT_BASE_URL, DEFAULT_MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT, TypeSafeClientConfig,
};
pub use error::TypeSafeError;
pub use models::{
    Answer, ChoiceAnswer, ChoiceCriteria, ChoiceQuestion, DEFAULT_MODEL, NoulAnswer, NoulCriteria,
    NoulQuestion, Question, QuestionContent, ScoreAnswer, ScoreCriteria, ScoreQuestion,
    SystemOneRequest, SystemOneResponse, SystemOneState, Usage,
};
pub use validation::validate_response;
