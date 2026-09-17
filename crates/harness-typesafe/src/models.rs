use std::collections::BTreeMap;

use serde::{Deserialize, Serialize, de::Error as DeError, ser::Error as SerError};
use serde_json::{Map, Value};

pub const DEFAULT_MODEL: &str = "jev-latest";

pub type QuestionContent = Value;
pub type SystemOneState = Value;
pub type ChoiceCriteria = BTreeMap<String, QuestionContent>;
pub type NoulCriteria = BTreeMap<String, QuestionContent>;
pub type ScoreCriteria = Vec<QuestionContent>;

/// TypeSafe calls a yes/no probability question a Noul question.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoulQuestion {
    pub instructions: QuestionContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub criteria: Option<NoulCriteria>,
}

impl NoulQuestion {
    pub fn new(instructions: impl Into<QuestionContent>) -> Self {
        Self {
            instructions: instructions.into(),
            criteria: None,
        }
    }

    pub fn with_criteria(mut self, criteria: NoulCriteria) -> Self {
        self.criteria = Some(criteria);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChoiceQuestion {
    pub instructions: QuestionContent,
    pub criteria: ChoiceCriteria,
}

impl ChoiceQuestion {
    pub fn new(instructions: impl Into<QuestionContent>, criteria: ChoiceCriteria) -> Self {
        Self {
            instructions: instructions.into(),
            criteria,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoreQuestion {
    pub instructions: QuestionContent,
    pub criteria: ScoreCriteria,
}

impl ScoreQuestion {
    pub fn new(instructions: impl Into<QuestionContent>, criteria: ScoreCriteria) -> Self {
        Self {
            instructions: instructions.into(),
            criteria,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Question {
    Noul(NoulQuestion),
    Choice(ChoiceQuestion),
    Score(ScoreQuestion),
}

impl Question {
    pub fn noul(instructions: impl Into<QuestionContent>) -> Self {
        Self::Noul(NoulQuestion::new(instructions))
    }

    pub fn choice(instructions: impl Into<QuestionContent>, criteria: ChoiceCriteria) -> Self {
        Self::Choice(ChoiceQuestion::new(instructions, criteria))
    }

    pub fn score(instructions: impl Into<QuestionContent>, criteria: ScoreCriteria) -> Self {
        Self::Score(ScoreQuestion::new(instructions, criteria))
    }
}

impl From<NoulQuestion> for Question {
    fn from(question: NoulQuestion) -> Self {
        Self::Noul(question)
    }
}

impl From<ChoiceQuestion> for Question {
    fn from(question: ChoiceQuestion) -> Self {
        Self::Choice(question)
    }
}

impl From<ScoreQuestion> for Question {
    fn from(question: ScoreQuestion) -> Self {
        Self::Score(question)
    }
}

impl Serialize for Question {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Noul(question) => serialize_tagged("noul", question, serializer),
            Self::Choice(question) => serialize_tagged("choice", question, serializer),
            Self::Score(question) => serialize_tagged("score", question, serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Question {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let (kind, value) = deserialize_tagged(deserializer)?;
        match kind.as_str() {
            "noul" => serde_json::from_value(value)
                .map(Self::Noul)
                .map_err(D::Error::custom),
            "choice" => serde_json::from_value(value)
                .map(Self::Choice)
                .map_err(D::Error::custom),
            "score" => serde_json::from_value(value)
                .map(Self::Score)
                .map_err(D::Error::custom),
            _ => Err(D::Error::custom("unsupported TypeSafe question type")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemOneRequest {
    pub state: SystemOneState,
    pub model: String,
    pub questions: BTreeMap<String, Question>,
}

impl SystemOneRequest {
    pub fn new(state: impl Into<SystemOneState>, questions: BTreeMap<String, Question>) -> Self {
        Self::for_model(state, DEFAULT_MODEL, questions)
    }

    pub fn for_model(
        state: impl Into<SystemOneState>,
        model: impl Into<String>,
        questions: BTreeMap<String, Question>,
    ) -> Self {
        Self {
            state: state.into(),
            model: model.into(),
            questions,
        }
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoulAnswer {
    pub noul: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChoiceAnswer {
    pub choice: String,
    pub probabilities: BTreeMap<String, f64>,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScoreAnswer {
    pub score: f64,
    pub legend: BTreeMap<String, String>,
    pub probabilities: BTreeMap<String, f64>,
    pub confidence: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Noul(NoulAnswer),
    Choice(ChoiceAnswer),
    Score(ScoreAnswer),
}

impl From<NoulAnswer> for Answer {
    fn from(answer: NoulAnswer) -> Self {
        Self::Noul(answer)
    }
}

impl From<ChoiceAnswer> for Answer {
    fn from(answer: ChoiceAnswer) -> Self {
        Self::Choice(answer)
    }
}

impl From<ScoreAnswer> for Answer {
    fn from(answer: ScoreAnswer) -> Self {
        Self::Score(answer)
    }
}

impl Serialize for Answer {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Noul(answer) => serialize_tagged("noul", answer, serializer),
            Self::Choice(answer) => serialize_tagged("choice", answer, serializer),
            Self::Score(answer) => serialize_tagged("score", answer, serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Answer {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let (kind, value) = deserialize_tagged(deserializer)?;
        match kind.as_str() {
            // Additive provider fields are ignored; required DTO fields remain strict.
            "noul" => serde_json::from_value(value)
                .map(Self::Noul)
                .map_err(D::Error::custom),
            "choice" => serde_json::from_value(value)
                .map(Self::Choice)
                .map_err(D::Error::custom),
            "score" => serde_json::from_value(value)
                .map(Self::Score)
                .map_err(D::Error::custom),
            _ => Err(D::Error::custom("unsupported TypeSafe answer type")),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemOneResponse {
    pub model: String,
    pub answers: BTreeMap<String, Answer>,
    pub usage: Usage,
    #[serde(skip)]
    pub request_id: Option<String>,
}

fn serialize_tagged<S, T>(kind: &str, value: &T, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
    T: Serialize,
{
    let mut object = serde_json::to_value(value)
        .map_err(S::Error::custom)?
        .as_object()
        .cloned()
        .ok_or_else(|| S::Error::custom("tagged value must serialize as an object"))?;
    object.insert("type".to_string(), Value::String(kind.to_string()));
    Value::Object(object).serialize(serializer)
}

fn deserialize_tagged<'de, D>(deserializer: D) -> Result<(String, Value), D::Error>
where
    D: serde::Deserializer<'de>,
{
    let mut object = Map::<String, Value>::deserialize(deserializer)?;
    let kind = object
        .remove("type")
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| D::Error::missing_field("type"))?;
    Ok((kind, Value::Object(object)))
}
