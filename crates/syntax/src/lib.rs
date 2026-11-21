//! Native syntax parsing, tool activity projection and semantic diffs.

mod activity;
pub mod changed_symbols;
mod classification;
pub mod intelligence;
mod registry;
pub mod semantic;

pub use activity::{
    analyze_activity, analyze_activity_until, ActivityAnalysis, ActivityInput, ActivityValue,
    LiteralCommand, Operation,
};

pub use registry::Grammar;
use std::ops::ControlFlow;
use std::time::Instant;
use tree_sitter::{ParseOptions, Parser, Tree};

impl Grammar {
    pub fn parse(self, source: &str) -> Option<Tree> {
        self.parse_with_deadline(source, None)
    }

    pub(crate) fn parse_with_deadline(
        self,
        source: &str,
        deadline: Option<Instant>,
    ) -> Option<Tree> {
        let mut parser = Parser::new();
        parser.set_language(&self.language()).ok()?;
        match deadline {
            Some(deadline) => {
                let mut expired = |_: &tree_sitter::ParseState| {
                    if Instant::now() >= deadline {
                        ControlFlow::Break(())
                    } else {
                        ControlFlow::Continue(())
                    }
                };
                parser.parse_with_options(
                    &mut |offset, _| source.as_bytes().get(offset..).unwrap_or_default(),
                    None,
                    Some(ParseOptions::new().progress_callback(&mut expired)),
                )
            }
            None => parser.parse(source, None),
        }
    }
}
