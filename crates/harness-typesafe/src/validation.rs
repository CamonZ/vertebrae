use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::{
    Answer, ChoiceQuestion, Question, ScoreQuestion, SystemOneRequest, SystemOneResponse,
    TypeSafeError,
};

impl SystemOneRequest {
    pub fn validate(&self) -> Result<(), TypeSafeError> {
        if !valid_content(&self.state) {
            return Err(invalid_request("state must be a string, object, or array"));
        }
        if self.model.trim().is_empty() {
            return Err(invalid_request("model must not be blank"));
        }
        if self.questions.is_empty() {
            return Err(invalid_request("questions must not be empty"));
        }

        for (question_id, question) in &self.questions {
            if question_id.trim().is_empty() {
                return Err(invalid_request("question IDs must not be blank"));
            }
            validate_question(question)?;
        }
        Ok(())
    }
}

pub fn validate_response(
    request: &SystemOneRequest,
    response: &SystemOneResponse,
) -> Result<(), TypeSafeError> {
    if response.model.trim().is_empty() {
        return Err(malformed_response("model must not be blank"));
    }
    if response.model != request.model {
        return Err(malformed_response(
            "response model does not match request model",
        ));
    }
    if response.answers.len() != request.questions.len() {
        return Err(malformed_response(
            "response answers do not match request questions",
        ));
    }

    for (question_id, question) in &request.questions {
        let answer = response
            .answers
            .get(question_id)
            .ok_or_else(|| malformed_response("response is missing an answer"))?;
        validate_answer(question, answer)?;
    }
    Ok(())
}

fn validate_question(question: &Question) -> Result<(), TypeSafeError> {
    match question {
        Question::Noul(question) => {
            require_content(&question.instructions, "noul.instructions")?;
            if let Some(criteria) = &question.criteria {
                if criteria.keys().any(|key| key != "true" && key != "false") {
                    return Err(invalid_request(
                        "noul criteria may only contain true and false",
                    ));
                }
                if criteria.values().any(|value| !valid_content(value)) {
                    return Err(invalid_request(
                        "noul criteria values must be strings, objects, or arrays",
                    ));
                }
            }
        }
        Question::Choice(question) => validate_choice_question(question)?,
        Question::Score(question) => validate_score_question(question)?,
    }
    Ok(())
}

fn validate_choice_question(question: &ChoiceQuestion) -> Result<(), TypeSafeError> {
    require_content(&question.instructions, "choice.instructions")?;
    if question.criteria.is_empty() || question.criteria.len() > 255 {
        return Err(invalid_request(
            "choice criteria must contain between 1 and 255 options",
        ));
    }
    if question.criteria.iter().any(|(option, description)| {
        option.trim().is_empty() || !valid_nullable_content(description)
    }) {
        return Err(invalid_request(
            "choice criteria must use nonblank options and valid descriptions",
        ));
    }
    Ok(())
}

fn validate_score_question(question: &ScoreQuestion) -> Result<(), TypeSafeError> {
    require_content(&question.instructions, "score.instructions")?;
    if !(2..=10).contains(&question.criteria.len()) {
        return Err(invalid_request(
            "score criteria must contain between 2 and 10 levels",
        ));
    }
    if question.criteria.iter().any(|value| !valid_content(value)) {
        return Err(invalid_request(
            "score criteria values must be strings, objects, or arrays",
        ));
    }
    Ok(())
}

fn validate_answer(question: &Question, answer: &Answer) -> Result<(), TypeSafeError> {
    match (question, answer) {
        (Question::Noul(_), Answer::Noul(answer)) => {
            ensure_probability(answer.noul, "noul probability")
        }
        (Question::Choice(question), Answer::Choice(answer)) => {
            if !question.criteria.contains_key(&answer.choice) {
                return Err(malformed_response(
                    "choice answer is not in question criteria",
                ));
            }
            validate_distribution(&answer.probabilities, question.criteria.keys().cloned())?;
            ensure_probability(answer.confidence, "choice confidence")
        }
        (Question::Score(question), Answer::Score(answer)) => {
            let expected_levels = (0..question.criteria.len()).map(|level| level.to_string());
            validate_distribution(&answer.probabilities, expected_levels)?;
            if answer.legend.len() != question.criteria.len()
                || !(0..question.criteria.len())
                    .all(|level| answer.legend.contains_key(&level.to_string()))
            {
                return Err(malformed_response("score legend does not match criteria"));
            }
            if !answer.score.is_finite()
                || !(0.0..=((question.criteria.len() - 1) as f64)).contains(&answer.score)
            {
                return Err(malformed_response("score is outside the criteria range"));
            }
            ensure_probability(answer.confidence, "score confidence")
        }
        _ => Err(malformed_response(
            "answer type does not match question type",
        )),
    }
}

fn validate_distribution(
    probabilities: &BTreeMap<String, f64>,
    expected_keys: impl IntoIterator<Item = String>,
) -> Result<(), TypeSafeError> {
    let expected_keys: BTreeSet<String> = expected_keys.into_iter().collect();
    if probabilities.len() != expected_keys.len()
        || probabilities.keys().any(|key| !expected_keys.contains(key))
    {
        return Err(malformed_response("probability keys do not match criteria"));
    }

    let sum = probabilities.values().try_fold(0.0, |sum, probability| {
        ensure_probability(*probability, "probability").map(|()| sum + probability)
    })?;
    if (sum - 1.0).abs() > 0.000_001 {
        return Err(malformed_response("probabilities must sum to one"));
    }
    Ok(())
}

fn ensure_probability(value: f64, field: &str) -> Result<(), TypeSafeError> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err(malformed_response(format!(
            "{field} must be between zero and one"
        )))
    }
}

fn valid_content(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.trim().is_empty(),
        Value::Object(_) | Value::Array(_) => true,
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

fn valid_nullable_content(value: &Value) -> bool {
    value.is_null() || valid_content(value)
}

fn require_content(value: &Value, field: &str) -> Result<(), TypeSafeError> {
    if valid_content(value) {
        Ok(())
    } else {
        Err(invalid_request(format!(
            "{field} must be a nonblank string, object, or array"
        )))
    }
}

fn invalid_request(message: impl Into<String>) -> TypeSafeError {
    TypeSafeError::InvalidRequest(message.into())
}

fn malformed_response(message: impl Into<String>) -> TypeSafeError {
    TypeSafeError::MalformedResponse(message.into())
}
