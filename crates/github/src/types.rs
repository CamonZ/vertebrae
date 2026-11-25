use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};

/// `/` stays literal because GitHub resolves slash-separated branch names in
/// `compare/<head>`; Git already forbids `:`, `?`, `[`, `\`, `^` and spaces in
/// ref names, but they are escaped defensively along with URL delimiters.
const BRANCH_PATH: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RepoRef {
    pub host: String,
    pub owner: String,
    pub repo: String,
}

impl RepoRef {
    pub fn new(host: impl Into<String>, owner: impl Into<String>, repo: impl Into<String>) -> Self {
        Self {
            host: host.into(),
            owner: owner.into(),
            repo: repo.into(),
        }
    }

    pub fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    /// GitHub repository names are case-insensitive.
    pub fn is_named(&self, full_name: &str) -> bool {
        full_name
            .split_once('/')
            .is_some_and(|(owner, repo)| self.is_same(owner, repo))
    }

    pub fn is_same(&self, owner: &str, repo: &str) -> bool {
        self.owner.eq_ignore_ascii_case(owner) && self.repo.eq_ignore_ascii_case(repo)
    }

    pub fn create_pr_url(&self, head: &RepoRef, branch: &str) -> String {
        let branch = utf8_percent_encode(branch, BRANCH_PATH);
        let head_ref = if self.is_same(&head.owner, &head.repo) {
            branch.to_string()
        } else {
            format!("{}:{branch}", head.owner)
        };
        format!(
            "https://{}/{}/{}/compare/{head_ref}?expand=1",
            self.host, self.owner, self.repo
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequestSummary {
    pub number: u64,
    pub title: String,
    pub state: PullRequestState,
    pub head_ref: String,
    /// `owner/repo` hosting the head branch (differs from base repo for forks;
    /// `None` when the head repository was deleted).
    pub head_repo: Option<String>,
    pub base_ref: String,
    pub url: String,
    pub author: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenPrSearchResult {
    pub prs: Vec<PullRequestSummary>,
    pub has_more: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_pr_url_escapes_path_characters_but_keeps_slashes() {
        let repo = RepoRef::new("github.com", "example", "demo-repo");
        assert_eq!(
            repo.create_pr_url(&repo, "feature/retry#2 ü"),
            "https://github.com/example/demo-repo/compare/feature/retry%232%20%C3%BC?expand=1"
        );
    }

    #[test]
    fn create_pr_url_targets_base_repo_with_fork_owner_prefix() {
        let base = RepoRef::new("github.com", "example", "demo-repo");
        let fork = RepoRef::new("github.com", "alice", "demo-repo");
        assert_eq!(
            base.create_pr_url(&fork, "feature/retry"),
            "https://github.com/example/demo-repo/compare/alice:feature/retry?expand=1"
        );
        let same_case_insensitive = RepoRef::new("github.com", "Example", "Demo-Repo");
        assert_eq!(
            base.create_pr_url(&same_case_insensitive, "main"),
            "https://github.com/example/demo-repo/compare/main?expand=1"
        );
    }

    #[test]
    fn is_named_compares_case_insensitively() {
        let repo = RepoRef::new("github.com", "example", "demo-repo");
        assert!(repo.is_named("Example/Demo-Repo"));
        assert!(!repo.is_named("example/other"));
        assert!(!repo.is_named("example"));
    }
}
