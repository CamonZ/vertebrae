//! Provider-neutral contracts shared by interactive and one-shot AI harnesses.
//!
//! This crate deliberately contains no provider wire types or surface-specific
//! orchestration. Provider adapters implement [`HarnessRuntime`], while GUI,
//! daemon, persistence, and replay consumers share the event and projection
//! contracts exposed here.

mod capabilities;
mod control;
mod event;
mod lifecycle;
mod projection;
mod runtime;

pub use capabilities::*;
pub use control::*;
pub use event::*;
pub use lifecycle::*;
pub use projection::*;
pub use runtime::*;
