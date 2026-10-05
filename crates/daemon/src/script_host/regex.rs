//! Bounded regular-expression helpers for execute scripts.
//!
//! The Rust `regex` engine has worst-case linear matching time and excludes
//! backreferences and look-around. Inputs, patterns, captures and replacement
//! output are capped so script-controlled inputs cannot grow without bound.

use rhai::{Array, Dynamic, ImmutableString, Module};

use super::string_argument;
use crate::script_worker::HostError;

pub(super) const NAMESPACE: &str = "vtb::regex";
const MAX_PATTERN_BYTES: usize = 4 * 1024;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_REPLACEMENT_BYTES: usize = 4 * 1024;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_CAPTURE_GROUPS: usize = 128;
const REGEX_SIZE_LIMIT: usize = 1024 * 1024;

pub(super) fn module() -> Module {
    let mut module = Module::new();
    module.set_native_fn("is_match", |text: Dynamic, pattern: Dynamic| {
        is_match(text, pattern).map_err(|error| error.in_function("vtb::regex::is_match").into())
    });
    module.set_native_fn(
        "captures",
        |text: Dynamic, pattern: Dynamic| -> Result<Dynamic, Box<rhai::EvalAltResult>> {
            captures(text, pattern)
                .map_err(|error| error.in_function("vtb::regex::captures").into())
        },
    );
    module.set_native_fn(
        "replace_all",
        |text: Dynamic, pattern: Dynamic, replacement: Dynamic| {
            replace_all(text, pattern, replacement)
                .map_err(|error| error.in_function("vtb::regex::replace_all").into())
        },
    );
    module
}

fn is_match(text: Dynamic, pattern: Dynamic) -> Result<bool, HostError> {
    let text = text_argument(text, "Text", MAX_TEXT_BYTES)?;
    let regex = regex_argument(pattern)?;
    Ok(regex.is_match(&text))
}

/// Return the first match's capture groups, including group zero. An unmatched
/// optional group is represented by Rhai's unit value; no match returns unit.
fn captures(text: Dynamic, pattern: Dynamic) -> Result<Dynamic, HostError> {
    let text = text_argument(text, "Text", MAX_TEXT_BYTES)?;
    let regex = regex_argument(pattern)?;
    let Some(captures) = regex.captures(&text) else {
        return Ok(Dynamic::UNIT);
    };
    if captures.len() > MAX_CAPTURE_GROUPS {
        return Err(HostError::invalid(format!(
            "Regex has more than {MAX_CAPTURE_GROUPS} capture groups"
        )));
    }
    Ok(captures
        .iter()
        .map(|capture| {
            capture.map_or(Dynamic::UNIT, |value| {
                Dynamic::from(value.as_str().to_owned())
            })
        })
        .collect::<Array>()
        .into())
}

fn replace_all(
    text: Dynamic,
    pattern: Dynamic,
    replacement: Dynamic,
) -> Result<ImmutableString, HostError> {
    let text = text_argument(text, "Text", MAX_TEXT_BYTES)?;
    let regex = regex_argument(pattern)?;
    let replacement = text_argument(replacement, "Replacement", MAX_REPLACEMENT_BYTES)?;
    let maximum_expansion = replacement
        .bytes()
        .filter(|byte| *byte == b'$')
        .count()
        .saturating_mul(text.len())
        .saturating_add(replacement.len());
    if maximum_expansion > MAX_OUTPUT_BYTES {
        return Err(HostError::invalid(format!(
            "Regex replacement expansion may exceed the {MAX_OUTPUT_BYTES}-byte output limit"
        )));
    }

    let mut output = String::with_capacity(text.len().min(MAX_OUTPUT_BYTES));
    let mut copied_to = 0;
    for captures in regex.captures_iter(&text) {
        let matched = captures.get(0).expect("every capture set has group zero");
        append_bounded(&mut output, &text[copied_to..matched.start()])?;
        let mut expansion = String::new();
        captures.expand(&replacement, &mut expansion);
        append_bounded(&mut output, &expansion)?;
        copied_to = matched.end();
    }
    append_bounded(&mut output, &text[copied_to..])?;
    Ok(output.into())
}

fn append_bounded(output: &mut String, value: &str) -> Result<(), HostError> {
    if output.len().saturating_add(value.len()) > MAX_OUTPUT_BYTES {
        return Err(HostError::invalid(format!(
            "Regex replacement output exceeds {MAX_OUTPUT_BYTES} bytes"
        )));
    }
    output.push_str(value);
    Ok(())
}

fn regex_argument(value: Dynamic) -> Result<regex::Regex, HostError> {
    let pattern = text_argument(value, "Regex pattern", MAX_PATTERN_BYTES)?;
    let mut builder = regex::RegexBuilder::new(&pattern);
    builder
        .size_limit(REGEX_SIZE_LIMIT)
        .dfa_size_limit(REGEX_SIZE_LIMIT)
        .nest_limit(64);
    builder
        .build()
        .map_err(|error| HostError::invalid(format!("Invalid regex pattern: {error}")))
}

fn text_argument(value: Dynamic, what: &str, max_bytes: usize) -> Result<String, HostError> {
    let text = string_argument(value, what)?;
    if text.len() > max_bytes {
        return Err(HostError::invalid(format!(
            "{what} exceeds the {max_bytes}-byte limit"
        )));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use rhai::{Engine, Map};

    use super::*;

    fn eval(source: &str) -> Dynamic {
        let mut engine = Engine::new();
        engine.register_static_module(NAMESPACE, module().into());
        engine.eval(source).unwrap()
    }

    #[test]
    fn matching_and_captures_are_available_to_scripts() {
        let value = eval(
            r##"#{ matched: vtb::regex::is_match("ticket-42", #"ticket-\d+"#), groups: vtb::regex::captures("ticket-42", #"ticket-(\d+)"#) }"##,
        );
        let value = value.cast::<Map>();
        assert!(value["matched"].as_bool().unwrap());
        let groups = value["groups"].clone().cast::<Array>();
        assert_eq!(groups[0].clone().cast::<String>(), "ticket-42");
        assert_eq!(groups[1].clone().cast::<String>(), "42");
    }

    #[test]
    fn optional_capture_and_no_match_have_documented_shapes() {
        let value = eval(
            r##"#{ unmatched: vtb::regex::captures("abc", #"(a)(z)?"#), absent: vtb::regex::captures("abc", #"xyz"#) }"##,
        )
        .cast::<Map>();
        let groups = value["unmatched"].clone().cast::<Array>();
        assert!(groups[2].is_unit());
        assert!(value["absent"].is_unit());
    }

    #[test]
    fn replacement_supports_capture_expansion() {
        let value = eval(r##"vtb::regex::replace_all("a1 b2", #"([a-z])(\d)"#, "$2$1")"##);
        assert_eq!(value.cast::<String>(), "1a 2b");
    }

    #[test]
    fn replacement_expansion_is_checked_before_allocating() {
        let text = "x".repeat(MAX_TEXT_BYTES);
        let replacement = "$0".repeat(20);
        let error = eval_error(&format!(
            "vtb::regex::replace_all({text:?}, \"x\", {replacement:?})"
        ));
        assert!(error.contains("expansion may exceed"), "{error}");
    }

    #[test]
    fn invalid_pattern_and_large_input_fail_clearly() {
        let error = eval_error(r#"vtb::regex::is_match("abc", "(")"#);
        assert!(error.contains("Invalid regex pattern"), "{error}");

        let oversized = format!("\"{}\"", "x".repeat(MAX_TEXT_BYTES + 1));
        let error = eval_error(&format!("vtb::regex::is_match({oversized}, \"x\")"));
        assert!(error.contains("Text exceeds"), "{error}");
    }

    fn eval_error(source: &str) -> String {
        let mut engine = Engine::new();
        engine.register_static_module(NAMESPACE, module().into());
        engine.eval::<Dynamic>(source).unwrap_err().to_string()
    }
}
