//! The primary rate-limit window GitHub reports with every response.

use reqwest::header::HeaderMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimitStatus {
    pub remaining: u32,
    /// Seconds until the window resets (0 when already past).
    pub reset_in_secs: u64,
}

impl RateLimitStatus {
    pub(crate) fn from_headers(headers: &HeaderMap) -> Option<Self> {
        let number = |name: &str| headers.get(name)?.to_str().ok()?.trim().parse::<u64>().ok();
        let remaining = u32::try_from(number("x-ratelimit-remaining")?).ok()?;
        let reset = number("x-ratelimit-reset")?;
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
        Some(Self {
            remaining,
            reset_in_secs: reset.saturating_sub(now),
        })
    }

    /// The tighter of two windows (fewer requests left).
    pub fn tightest(a: Option<Self>, b: Option<Self>) -> Option<Self> {
        match (a, b) {
            (Some(a), Some(b)) => Some(if b.remaining < a.remaining { b } else { a }),
            (a, b) => a.or(b),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::generators as gs;

    fn window(tc: &hegel::TestCase) -> Option<RateLimitStatus> {
        tc.draw(gs::booleans()).then(|| RateLimitStatus {
            // A narrow range makes ties between windows common.
            remaining: if tc.draw(gs::booleans()) {
                tc.draw(gs::integers::<u32>().max_value(3))
            } else {
                tc.draw(gs::integers::<u32>())
            },
            reset_in_secs: tc.draw(gs::integers::<u64>()),
        })
    }

    /// Folding windows in any grouping gives the same answer: `None` is the
    /// identity, the result is one of the inputs, it has the fewest requests
    /// left, and it is `None` only when every input is.
    #[hegel::test]
    fn tightest_is_an_associative_minimum_with_none_as_identity(tc: hegel::TestCase) {
        let (a, b, c) = (window(&tc), window(&tc), window(&tc));
        tc.note(&format!("a={a:?} b={b:?} c={c:?}"));

        assert_eq!(RateLimitStatus::tightest(a, None), a);
        assert_eq!(RateLimitStatus::tightest(None, a), a);
        assert_eq!(
            RateLimitStatus::tightest(a, RateLimitStatus::tightest(b, c)),
            RateLimitStatus::tightest(RateLimitStatus::tightest(a, b), c)
        );

        let inputs = [a, b, c];
        let folded = inputs.into_iter().fold(None, RateLimitStatus::tightest);
        let fewest = inputs.iter().flatten().map(|w| w.remaining).min();
        assert_eq!(folded.map(|w| w.remaining), fewest);
        if let Some(folded) = folded {
            assert!(inputs.contains(&Some(folded)));
        }
    }
}
