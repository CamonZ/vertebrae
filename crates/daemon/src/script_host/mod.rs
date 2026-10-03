//! Production `vtb::*` host modules for Rhai execute scripts.
//!
//! Every function runs on the script's blocking worker thread. Service
//! functions reach Sacrum through [`HostContext::call`], which supplies the
//! execution's project and races the attempt's cancellation; `vtb::cmd` runs
//! local processes through [`HostContext::block_on_owned`]. Scripts never pass project
//! IDs; anything outside the execution's project behaves as absent.

mod artifacts;
mod cmd;
mod task_edits;
mod task_writes;
mod tasks;
#[cfg(test)]
mod test_support;

use rhai::{Dynamic, Engine, Map, Module};
use vertebrae_core::{ServiceResult, VertebraeServices};

use crate::script_worker::{HostContext, HostError, HostErrorKind};

pub(crate) fn register(engine: &mut Engine, host: &HostContext) {
    engine.register_static_module("vtb::tasks", tasks::module(host).into());
    engine.register_static_module("vtb::artifacts", artifacts::module(host).into());
    engine.register_static_module("vtb::cmd", cmd::module(host).into());
}

/// Register a one-argument host function whose errors carry its qualified
/// name. Arguments arrive as `Dynamic` so wrong types raise `invalid` instead
/// of Rhai's function-not-found error.
fn set_host_fn(
    module: &mut Module,
    host: &HostContext,
    namespace: &str,
    name: &str,
    function: fn(&HostContext, Dynamic) -> Result<Dynamic, HostError>,
) {
    let host = host.clone();
    let qualified = format!("{namespace}::{name}");
    module.set_native_fn(name, move |argument: Dynamic| {
        function(&host, argument).map_err(|error| error.in_function(qualified.as_str()).into())
    });
}

/// Register a two-argument host function; see [`set_host_fn`].
fn set_host_fn2(
    module: &mut Module,
    host: &HostContext,
    namespace: &str,
    name: &str,
    function: fn(&HostContext, Dynamic, Dynamic) -> Result<Dynamic, HostError>,
) {
    let host = host.clone();
    let qualified = format!("{namespace}::{name}");
    module.set_native_fn(name, move |first: Dynamic, second: Dynamic| {
        function(&host, first, second).map_err(|error| error.in_function(qualified.as_str()).into())
    });
}

/// Register a three-argument host function; see [`set_host_fn`].
fn set_host_fn3(
    module: &mut Module,
    host: &HostContext,
    namespace: &str,
    name: &str,
    function: fn(&HostContext, Dynamic, Dynamic, Dynamic) -> Result<Dynamic, HostError>,
) {
    let host = host.clone();
    let qualified = format!("{namespace}::{name}");
    module.set_native_fn(
        name,
        move |first: Dynamic, second: Dynamic, third: Dynamic| {
            function(&host, first, second, third)
                .map_err(|error| error.in_function(qualified.as_str()).into())
        },
    );
}

/// Register a four-argument host function; see [`set_host_fn`].
fn set_host_fn4(
    module: &mut Module,
    host: &HostContext,
    namespace: &str,
    name: &str,
    function: fn(&HostContext, Dynamic, Dynamic, Dynamic, Dynamic) -> Result<Dynamic, HostError>,
) {
    let host = host.clone();
    let qualified = format!("{namespace}::{name}");
    module.set_native_fn(
        name,
        move |first: Dynamic, second: Dynamic, third: Dynamic, fourth: Dynamic| {
            function(&host, first, second, third, fourth)
                .map_err(|error| error.in_function(qualified.as_str()).into())
        },
    );
}

/// Make one host call for a read. Arguments are validated before any request,
/// so whatever the service reports here is a backend failure rather than a
/// script mistake: everything but cancellation surfaces as `transport`.
/// Reads turn an absent target into `None` inside `request`.
fn read<'a, T, F>(
    host: &'a HostContext,
    request: impl FnOnce(&'a VertebraeServices, &'a str) -> F,
) -> Result<T, HostError>
where
    F: std::future::Future<Output = ServiceResult<T>>,
{
    host.call(request).map_err(|error| match error.kind {
        HostErrorKind::Cancelled => error,
        _ => HostError {
            kind: HostErrorKind::Transport,
            ..error
        },
    })
}

/// A full hyphenated UUID, normalized to lowercase. Short IDs are rejected.
fn uuid_argument(value: Dynamic, what: &str) -> Result<String, HostError> {
    uuid_text(string_argument(value, what)?, what)
}

fn uuid_text(text: String, what: &str) -> Result<String, HostError> {
    let parsed = (text.len() == 36)
        .then(|| uuid::Uuid::try_parse(&text).ok())
        .flatten()
        .ok_or_else(|| HostError::invalid(format!("{what} must be a full UUID, got {text:?}")))?;
    Ok(parsed.hyphenated().to_string())
}

fn string_argument(value: Dynamic, what: &str) -> Result<String, HostError> {
    let type_name = value.type_name();
    value
        .into_immutable_string()
        .map(|text| text.to_string())
        .map_err(|_| HostError::invalid(format!("{what} must be a string, got {type_name}")))
}

fn map_argument(value: Dynamic, what: &str) -> Result<Map, HostError> {
    let type_name = value.type_name();
    value
        .try_cast::<Map>()
        .ok_or_else(|| HostError::invalid(format!("{what} must be a map, got {type_name}")))
}

fn bool_argument(value: Dynamic, what: &str) -> Result<bool, HostError> {
    let type_name = value.type_name();
    value
        .as_bool()
        .map_err(|_| HostError::invalid(format!("{what} must be a boolean, got {type_name}")))
}

fn optional_string(value: Option<&str>) -> Dynamic {
    value.map_or(Dynamic::UNIT, Into::into)
}

fn timestamp(value: Option<chrono::DateTime<chrono::Utc>>) -> Dynamic {
    value.map_or(Dynamic::UNIT, |at| at.to_rfc3339().into())
}
