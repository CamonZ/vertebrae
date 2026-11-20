//! Native syntax parsing and tool activity projection.

mod activity;
mod classification;

pub use activity::{
    analyze_activity, analyze_activity_until, ActivityAnalysis, ActivityInput, ActivityValue,
    LiteralCommand, Operation,
};

use std::time::Instant;
use tree_sitter::{Language, ParseOptions, Parser, Tree};

#[derive(Clone, Copy)]
pub enum Grammar {
    Bash,
    JavaScript,
    Python,
}

impl Grammar {
    pub fn name(self) -> &'static str {
        self.entry().0
    }

    pub fn language(self) -> Language {
        self.entry().1.into()
    }

    fn entry(self) -> (&'static str, tree_sitter_language::LanguageFn) {
        match self {
            Self::Bash => ("bash", tree_sitter_bash::LANGUAGE),
            Self::JavaScript => ("javascript", tree_sitter_javascript::LANGUAGE),
            Self::Python => ("python", tree_sitter_python::LANGUAGE),
        }
    }

    pub fn parse(self, source: &str) -> Option<Tree> {
        self.parse_with_deadline(source, None)
    }

    fn parse_with_deadline(self, source: &str, deadline: Option<Instant>) -> Option<Tree> {
        let mut parser = Parser::new();
        parser.set_language(&self.language()).ok()?;
        match deadline {
            Some(deadline) => {
                let mut expired = |_: &tree_sitter::ParseState| Instant::now() >= deadline;
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
