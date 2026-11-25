use crate::RepoRef;

/// Non-GitHub remotes, SSH config host aliases (which would need `~/.ssh/config`
/// to resolve) and malformed URLs return `None`.
pub fn parse_github_remote_url(raw: &str) -> Option<RepoRef> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if !trimmed.contains("://") {
        let (host_part, path_part) = trimmed.split_once(':')?;
        let host = host_part
            .rsplit_once('@')
            .map(|(_, h)| h)
            .unwrap_or(host_part);
        return parse_owner_repo(github_host(host)?, path_part);
    }

    let parsed = url::Url::parse(trimmed).ok()?;
    let scheme = parsed.scheme();
    if !matches!(scheme, "https" | "http" | "ssh" | "git") {
        return None;
    }
    parse_owner_repo(github_host(parsed.host_str()?)?, parsed.path())
}

fn github_host(host: &str) -> Option<&'static str> {
    let host = host.to_ascii_lowercase();
    matches!(host.as_str(), "github.com" | "ssh.github.com").then_some("github.com")
}

fn parse_owner_repo(host: &str, path: &str) -> Option<RepoRef> {
    let stripped = path.trim_start_matches('/').trim_end_matches('/');
    let mut parts = stripped.split('/');
    let owner = parts.next()?.trim();
    let repo_raw = parts.next()?.trim();
    if parts.next().is_some() {
        return None;
    }
    let repo = repo_raw.strip_suffix(".git").unwrap_or(repo_raw);
    // `.`/`..` segments would traverse when the names are placed in API or
    // web URL paths; GitHub does not allow them as owner or repository names.
    if [owner, repo]
        .iter()
        .any(|part| part.is_empty() || matches!(*part, "." | ".."))
    {
        return None;
    }
    Some(RepoRef::new(host, owner, repo))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_github_remote_urls() {
        let expected = RepoRef::new("github.com", "example", "demo-repo");
        for raw in [
            "https://github.com/example/demo-repo",
            "https://github.com/example/demo-repo.git",
            "https://github.com/example/demo-repo/",
            "git@github.com:example/demo-repo.git",
            "git@github.com:example/demo-repo",
            "ssh://git@github.com/example/demo-repo.git",
            "ssh://git@github.com:22/example/demo-repo.git",
            "https://GITHUB.COM/example/demo-repo.git",
            "ssh://git@ssh.github.com:443/example/demo-repo.git",
            "https://alice:token@github.com/example/demo-repo.git",
            "git://github.com/example/demo-repo.git",
            "  git@github.com:example/demo-repo.git\n",
        ] {
            assert_eq!(
                parse_github_remote_url(raw),
                Some(expected.clone()),
                "{raw}"
            );
        }
    }

    #[test]
    fn rejects_non_github_and_malformed_remotes() {
        for raw in [
            "",
            "   ",
            "https://gitlab.com/example/demo-repo.git",
            "git@bitbucket.org:example/demo-repo.git",
            "https://github.com/example",
            "https://github.com/example/demo-repo/extra",
            "/local/path/to/repo",
            "github-work:example/demo-repo.git",
            "git@github-work:example/demo-repo.git",
            "ftp://github.com/example/demo-repo.git",
            "https://github.com/../demo-repo",
            "git@github.com:example/..",
            "https://github.example.com/example/demo-repo.git",
        ] {
            assert_eq!(parse_github_remote_url(raw), None, "{raw}");
        }
    }

    #[test]
    fn dotted_names_other_than_traversal_are_kept() {
        assert_eq!(
            parse_github_remote_url("https://github.com/example/demo..repo.git"),
            Some(RepoRef::new("github.com", "example", "demo..repo"))
        );
    }
}
