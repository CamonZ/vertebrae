//! GitHub's GraphQL node IDs, checked the same way wherever one crosses a
//! boundary (a write's target, a catalog link to a review thread).

/// GitHub node IDs are short; anything longer is not one.
pub const MAX_NODE_ID_LEN: usize = 256;

/// Whether `id` looks like a GitHub node ID: 1 to [`MAX_NODE_ID_LEN`] bytes
/// of (URL-safe) Base64 with its type prefix, e.g. `PRRT_kwDOAbc123`.
/// Anything else (blank, spaces, separators such as `:`) is refused before
/// it reaches GitHub or a catalog reference.
pub fn is_valid_node_id(id: &str) -> bool {
    (1..=MAX_NODE_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'='))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_github_ids_and_refuses_everything_else() {
        for id in ["PRRT_kwDOAbc123-_=", "PR_kwDOA", "MDExOlB1bGxSZXF1ZXN0MQ=="] {
            assert!(is_valid_node_id(id), "{id}");
        }
        for id in [
            "",
            " ",
            "PRRT 1",
            "PRRT_1\n",
            "github-thread:PRRT_1",
            "é",
            "a/b",
        ] {
            assert!(!is_valid_node_id(id), "{id:?}");
        }
        assert!(is_valid_node_id(&"a".repeat(MAX_NODE_ID_LEN)));
        assert!(!is_valid_node_id(&"a".repeat(MAX_NODE_ID_LEN + 1)));
    }

    /// Against an independent oracle: the ID alphabet spelled out as a set,
    /// and the length limit in characters (the alphabet is ASCII).
    #[hegel::test(test_cases = 300)]
    fn agrees_with_the_id_alphabet(tc: hegel::TestCase) {
        use hegel::generators as gs;
        const ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-=";
        let id = if tc.draw(gs::booleans()) {
            tc.draw(gs::text().max_size(12))
        } else {
            let len = tc.draw(gs::integers::<usize>().max_value(MAX_NODE_ID_LEN + 4));
            let pick = tc.draw(gs::integers::<usize>().max_value(ALPHABET.len() - 1));
            let mut id: String = ALPHABET.chars().cycle().skip(pick).take(len).collect();
            if tc.draw(gs::booleans()) {
                id.push_str(&tc.draw(gs::text().max_size(2)));
            }
            id
        };
        let expected = !id.is_empty()
            && id.chars().count() <= MAX_NODE_ID_LEN
            && id.chars().all(|c| ALPHABET.contains(c));
        assert_eq!(is_valid_node_id(&id), expected, "{id:?}");
    }
}
