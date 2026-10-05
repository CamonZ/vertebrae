//! ISO 8601 calendar timestamp parsing and UTC millisecond arithmetic.
//!
//! The supported input profile is an extended calendar date (`YYYY-MM-DD`)
//! or an extended date-time with an explicit UTC offset, such as
//! `2026-10-05T12:30Z` and `2026-10-05T12:30:45.123+02:00`. Date-only inputs
//! are interpreted as midnight UTC. Local date-times without an offset are
//! rejected as ambiguous. Values are signed Unix epoch milliseconds; parsing
//! truncates fractional precision below one millisecond, and formatting emits
//! UTC RFC 3339 with millisecond precision.

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rhai::{Dynamic, ImmutableString, Module};

use super::string_argument;
use crate::script_worker::HostError;

pub(super) const NAMESPACE: &str = "vtb::time";
const MAX_TIMESTAMP_BYTES: usize = 128;

pub(super) fn module() -> Module {
    let mut module = Module::new();
    module.set_native_fn("parse_iso8601", |value: Dynamic| {
        parse_iso8601(value).map_err(|error| error.in_function("vtb::time::parse_iso8601").into())
    });
    module.set_native_fn("format_iso8601", |value: Dynamic| {
        format_iso8601(value).map_err(|error| error.in_function("vtb::time::format_iso8601").into())
    });
    module.set_native_fn("add_millis", |timestamp: Dynamic, millis: Dynamic| {
        add_millis(timestamp, millis)
            .map_err(|error| error.in_function("vtb::time::add_millis").into())
    });
    module.set_native_fn("subtract_millis", |timestamp: Dynamic, millis: Dynamic| {
        subtract_millis(timestamp, millis)
            .map_err(|error| error.in_function("vtb::time::subtract_millis").into())
    });
    module.set_native_fn("difference_millis", |later: Dynamic, earlier: Dynamic| {
        difference_millis(later, earlier)
            .map_err(|error| error.in_function("vtb::time::difference_millis").into())
    });
    module
}

fn parse_iso8601(value: Dynamic) -> Result<i64, HostError> {
    let value = string_argument(value, "Timestamp")?;
    if value.len() > MAX_TIMESTAMP_BYTES {
        return Err(HostError::invalid(format!(
            "Timestamp exceeds the {MAX_TIMESTAMP_BYTES}-byte limit"
        )));
    }

    if let Ok(timestamp) = DateTime::parse_from_rfc3339(&value) {
        return Ok(timestamp.timestamp_millis());
    }

    // ISO 8601 allows calendar date-times with minute precision. Require an
    // offset for every date-time; interpreting a local clock value would make
    // results depend on the daemon host's timezone.
    for format in ["%Y-%m-%dT%H:%M:%S%.f%:z", "%Y-%m-%dT%H:%M%:z"] {
        if let Ok(timestamp) = DateTime::parse_from_str(&value, format) {
            return Ok(timestamp.timestamp_millis());
        }
    }

    if let Ok(date) = NaiveDate::parse_from_str(&value, "%Y-%m-%d") {
        let midnight = date.and_hms_opt(0, 0, 0).expect("midnight is always valid");
        return Ok(DateTime::<Utc>::from_naive_utc_and_offset(midnight, Utc).timestamp_millis());
    }

    Err(HostError::invalid(format!(
        "Timestamp {value:?} is not a supported ISO 8601 calendar date or offset date-time"
    )))
}

fn format_iso8601(value: Dynamic) -> Result<ImmutableString, HostError> {
    let millis = integer_argument(value, "Timestamp milliseconds")?;
    let timestamp = DateTime::from_timestamp_millis(millis).ok_or_else(|| {
        HostError::invalid(format!("Timestamp milliseconds {millis} is out of range"))
    })?;
    Ok(timestamp
        .to_rfc3339_opts(SecondsFormat::Millis, true)
        .into())
}

fn add_millis(timestamp: Dynamic, millis: Dynamic) -> Result<i64, HostError> {
    let timestamp = integer_argument(timestamp, "Timestamp milliseconds")?;
    let millis = integer_argument(millis, "Duration milliseconds")?;
    checked_timestamp(timestamp.checked_add(millis))
}

fn subtract_millis(timestamp: Dynamic, millis: Dynamic) -> Result<i64, HostError> {
    let timestamp = integer_argument(timestamp, "Timestamp milliseconds")?;
    let millis = integer_argument(millis, "Duration milliseconds")?;
    checked_timestamp(timestamp.checked_sub(millis))
}

/// Return `later - earlier`, rejecting signed 64-bit overflow.
fn difference_millis(later: Dynamic, earlier: Dynamic) -> Result<i64, HostError> {
    let later = integer_argument(later, "Later timestamp milliseconds")?;
    let earlier = integer_argument(earlier, "Earlier timestamp milliseconds")?;
    later.checked_sub(earlier).ok_or_else(|| {
        HostError::invalid("Timestamp difference overflows signed 64-bit milliseconds")
    })
}

fn checked_timestamp(value: Option<i64>) -> Result<i64, HostError> {
    value.ok_or_else(|| {
        HostError::invalid("Timestamp arithmetic overflows signed 64-bit milliseconds")
    })
}

fn integer_argument(value: Dynamic, what: &str) -> Result<i64, HostError> {
    let type_name = value.type_name();
    value
        .as_int()
        .map_err(|_| HostError::invalid(format!("{what} must be an integer, got {type_name}")))
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

    fn eval_error(source: &str) -> String {
        let mut engine = Engine::new();
        engine.register_static_module(NAMESPACE, module().into());
        engine.eval::<Dynamic>(source).unwrap_err().to_string()
    }

    #[test]
    fn parses_date_only_and_offset_date_times_to_epoch_millis() {
        let value = eval(
            r#"#{ date: vtb::time::parse_iso8601("1970-01-02"), zulu: vtb::time::parse_iso8601("1970-01-01T00:00:01.250Z"), offset: vtb::time::parse_iso8601("1970-01-01T01:00+01:00") }"#,
        )
        .cast::<Map>();
        assert_eq!(value["date"].as_int().unwrap(), 86_400_000);
        assert_eq!(value["zulu"].as_int().unwrap(), 1_250);
        assert_eq!(value["offset"].as_int().unwrap(), 0);
    }

    #[test]
    fn formats_and_performs_checked_millisecond_arithmetic() {
        let value = eval(
            r#"let start = vtb::time::parse_iso8601("2026-10-05T12:30:00+02:00"); let end = vtb::time::add_millis(start, 1500); #{ formatted: vtb::time::format_iso8601(end), elapsed: vtb::time::difference_millis(end, start), before: vtb::time::subtract_millis(end, 1500) == start }"#,
        )
        .cast::<Map>();
        assert_eq!(
            value["formatted"].clone().cast::<String>(),
            "2026-10-05T10:30:01.500Z"
        );
        assert_eq!(value["elapsed"].as_int().unwrap(), 1_500);
        assert!(value["before"].as_bool().unwrap());
    }

    #[test]
    fn rejects_ambiguous_local_datetime_and_bad_input() {
        for timestamp in ["2026-10-05T12:30:00", "not-a-timestamp"] {
            let error = eval_error(&format!("vtb::time::parse_iso8601({timestamp:?})"));
            assert!(error.contains("not a supported ISO 8601"), "{error}");
        }
    }

    #[test]
    fn arithmetic_overflow_is_reported() {
        let error = eval_error("vtb::time::add_millis(9223372036854775807, 1)");
        assert!(error.contains("overflows signed 64-bit"), "{error}");
    }

    #[test]
    fn rejects_out_of_range_formatting_value() {
        let error = eval_error("vtb::time::format_iso8601(9223372036854775807)");
        assert!(error.contains("is out of range"), "{error}");
    }

    #[test]
    fn rejects_timestamp_strings_over_the_limit() {
        let input = format!("\"{}\"", "x".repeat(MAX_TIMESTAMP_BYTES + 1));
        let error = eval_error(&format!("vtb::time::parse_iso8601({input})"));
        assert!(error.contains("Timestamp exceeds"), "{error}");
    }
}
