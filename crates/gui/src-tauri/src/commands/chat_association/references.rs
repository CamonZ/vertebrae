//! Explicit entity and worktree references in a user message. Only entities of
//! the conversation's project and its real Git worktrees can be named.
use super::{AssociationEntity, AssociationWorktree};
use async_trait::async_trait;
use std::path::Path;

/// What a message names: nothing, exactly one entity, or a reference that
/// cannot be resolved to one (with an actionable diagnostic).
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Named<T> {
    Nothing,
    One(T),
    Unresolved(String),
}

/// Project-scoped entity lookup by a full UUID or 8+ character ID prefix.
#[async_trait]
pub(super) trait EntityLookup: Send + Sync {
    /// The project's single entity with this ID prefix; `None` when absent or ambiguous.
    async fn by_prefix(&self, prefix: &str) -> Result<Option<AssociationEntity>, ()>;
}

/// True when `token` is an 8+ character prefix of a hyphenated UUID.
fn is_id_prefix(token: &str) -> bool {
    const SHAPE: &[u8] = b"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
    token.len() >= 8
        && token.len() <= SHAPE.len()
        && token.bytes().zip(SHAPE).all(|(c, s)| match s {
            b'-' => c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Distinct lowercase entity ID references (full UUIDs or 8+ character prefixes).
pub(super) fn entity_tokens(message: &str) -> Vec<String> {
    let mut tokens: Vec<String> = vec![];
    for token in message
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .map(|token| token.trim_end_matches('-').to_lowercase())
        .filter(|token| is_id_prefix(token))
    {
        if !tokens.contains(&token) {
            tokens.push(token);
        }
    }
    tokens
}

pub(super) fn mentions_worktree(message: &str) -> bool {
    message.to_lowercase().contains("worktree")
}

/// The single entity a message names by ID, within the conversation project.
pub(super) async fn named_entity(
    message: &str,
    lookup: &dyn EntityLookup,
) -> Named<AssociationEntity> {
    let tokens = entity_tokens(message);
    if tokens.len() > 4 {
        return Named::Unresolved(
            "The message names too many IDs; name one entity to associate.".into(),
        );
    }

    let mut found: Vec<AssociationEntity> = vec![];
    let mut unresolved = vec![];
    for token in tokens.iter().take(4) {
        // The cache may contain only one of several matching project records.
        // Resolve the entire reference in the owning project before selecting.
        let entity = match lookup.by_prefix(token).await {
            Ok(entity) => entity.filter(|t| t.id.to_lowercase().starts_with(token.as_str())),
            Err(()) => {
                return Named::Unresolved(format!(
                    "Could not look up entity {token}; the association was kept."
                ))
            }
        };

        match entity {
            Some(entity) if !found.iter().any(|f| f.id == entity.id) => found.push(entity),
            Some(_) => (),
            None => unresolved.push(token.as_str()),
        }
    }

    match (found.len(), unresolved.is_empty()) {
        (1, true) => Named::One(found.remove(0)),
        (0, true) => Named::Nothing,
        (_, false) => Named::Unresolved(format!(
            "No single entity in this project matches {}. Use its full ID or a unique 8-character short ID.",
            unresolved.join(", ")
        )),
        _ => Named::Unresolved(
            "The message names several entities; name one to associate.".into(),
        ),
    }
}

fn expand_home(token: &str) -> Option<std::path::PathBuf> {
    match token.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME").map(|home| Path::new(&home).join(rest)),
        None => token.starts_with('/').then(|| token.into()),
    }
}

/// The single inventory worktree a message names by canonical path, unique
/// directory name or branch.
pub(super) fn named_worktree(
    message: &str,
    inventory: &[AssociationWorktree],
) -> Named<AssociationWorktree> {
    let basename = |w: &AssociationWorktree| {
        Path::new(&w.path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
    };

    let mut found: Vec<&AssociationWorktree> = vec![];
    let tokens = message
        .split(|c: char| {
            c.is_whitespace()
                || [
                    '\'', '"', '`', '(', ')', ',', ';', '<', '>', '“', '”', '‘', '’',
                ]
                .contains(&c)
        })
        .map(|token| token.trim_end_matches(['.', ':', '!', '?']))
        .filter(|token| !token.is_empty())
        .take(256);
    for token in tokens {
        let path = expand_home(token).and_then(|path| std::fs::canonicalize(path).ok());
        let trimmed = token.trim_end_matches('/');
        let matches = inventory.iter().filter(|w| match &path {
            Some(path) => Path::new(&w.path) == path,
            None => {
                w.branch.as_deref() == Some(trimmed)
                    || (basename(w).as_deref() == Some(trimmed)
                        && inventory
                            .iter()
                            .filter(|other| basename(other).as_deref() == Some(trimmed))
                            .count()
                            == 1)
            }
        });

        for worktree in matches {
            if !found.contains(&worktree) {
                found.push(worktree);
            }
        }
    }

    match found.as_slice() {
        [] => Named::Nothing,
        [one] => Named::One((*one).clone()),
        _ => {
            Named::Unresolved("The message matches several worktrees; name one by its path.".into())
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A project's entities, as the project-scoped backend would resolve them.
    pub(in super::super) struct ProjectEntities {
        pub entities: Vec<AssociationEntity>,
        pub fail: bool,
        pub asked: Mutex<Vec<String>>,
    }

    impl ProjectEntities {
        pub fn new(entities: Vec<AssociationEntity>) -> Self {
            Self {
                entities,
                fail: false,
                asked: Mutex::new(vec![]),
            }
        }
    }
    #[async_trait]
    impl EntityLookup for ProjectEntities {
        async fn by_prefix(&self, prefix: &str) -> Result<Option<AssociationEntity>, ()> {
            self.asked.lock().unwrap().push(prefix.into());
            if self.fail {
                return Err(());
            }

            let mut matches = self.entities.iter().filter(|t| t.id.starts_with(prefix));
            Ok(match (matches.next(), matches.next()) {
                (Some(entity), None) => Some(entity.clone()),
                _ => None,
            })
        }
    }

    fn entity(id: &str) -> AssociationEntity {
        AssociationEntity {
            id: id.into(),
            title: format!("Entity {}", &id[..8]),
            level: crate::types::TaskLevel::Ticket,
        }
    }

    const CACHED: &str = "f6f6bf5e-2ca1-4e50-bcfa-9e08944eaa78";
    const UNCACHED: &str = "f17de40f-4496-4d22-8edf-9c2192f4e860";

    #[test]
    fn entity_tokens_accept_full_ids_and_short_ids_only() {
        assert_eq!(
            entity_tokens(&format!("look at {UNCACHED}, then F6F6BF5E.")),
            [UNCACHED, "f6f6bf5e"]
        );

        assert!(entity_tokens("commit 470c1274abcdef0123 and f6f6bf5 or deadbee").is_empty());
        assert!(entity_tokens("worktree vertebrae-f17de40f").is_empty());
        assert_eq!(entity_tokens("f17de40f f17de40f-"), ["f17de40f"]);
    }

    #[tokio::test]
    async fn full_and_short_ids_select_the_same_project_entity() {
        let project = ProjectEntities::new(vec![entity(CACHED), entity(UNCACHED)]);
        for id in [CACHED, &CACHED[..8], UNCACHED, &UNCACHED[..8]] {
            let expected = if id.starts_with("f6") {
                CACHED
            } else {
                UNCACHED
            };

            for message in [
                format!("Let’s look at {id}, then let’s create a worktree for it and implement it there"),
                format!("Create a worktree for the following entity {id}"),
                format!("Let’s tie this conversation with the following entity {id}"),
            ] {
                assert_eq!(
                    named_entity(&message, &project).await,
                    Named::One(entity(expected)),
                    "{message}"
                );
            }
        }
        assert!(!project.asked.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn unknown_foreign_or_ambiguous_ids_are_unresolved() {
        let project = ProjectEntities::new(vec![
            entity(CACHED),
            entity("97a3edab-5e4a-40a8-b580-19708657a222"),
            entity("97a3edab-0000-40a8-b580-19708657a222"),
        ]);
        // Same short ID as a project entity, but a different (foreign) full ID.
        let foreign = "f6f6bf5e-0000-4000-8000-000000000000";
        for message in [
            format!("tie this to {foreign}"),
            "tie this to 0123abcd".into(),
            "tie this to 97a3edab".into(),
        ] {
            assert!(
                matches!(named_entity(&message, &project).await, Named::Unresolved(_)),
                "{message}"
            );
        }
        assert!(matches!(
            named_entity("compare f6f6bf5e and 97a3edab-5e4a", &project).await,
            Named::Unresolved(_)
        ));

        assert_eq!(named_entity("no reference", &project).await, Named::Nothing);
        let down = ProjectEntities {
            fail: true,
            ..ProjectEntities::new(vec![])
        };

        assert!(matches!(
            named_entity("tie this to f17de40f", &down).await,
            Named::Unresolved(_)
        ));
    }

    #[test]
    fn worktrees_are_named_by_path_unique_directory_or_branch() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let dir = |name: &str| {
            let path = root.join(name);
            std::fs::create_dir_all(&path).unwrap();
            path.to_string_lossy().into_owned()
        };

        let main = AssociationWorktree {
            path: dir("main"),
            branch: Some("master".into()),
        };

        let spike = AssociationWorktree {
            path: dir("scratch"),
            branch: Some("experiment/retry".into()),
        };

        let twin_a = AssociationWorktree {
            path: dir("a/twin"),
            branch: None,
        };

        let twin_b = AssociationWorktree {
            path: dir("b/twin"),
            branch: None,
        };

        let inventory = [main.clone(), spike.clone(), twin_a.clone(), twin_b];
        let named = |message: &str| named_worktree(message, &inventory);
        for message in [
            format!(
                "Let’s tie this conversation with the worktree {}",
                spike.path
            ),
            format!(
                "Let’s tie this conversation with the worktree {}/.",
                spike.path
            ),
            "Let’s tie this conversation with the worktree scratch".into(),
            "Let’s tie this conversation with the worktree `experiment/retry`.".into(),
        ] {
            assert_eq!(named(&message), Named::One(spike.clone()), "{message}");
        }
        assert_eq!(named(&format!("use {}", twin_a.path)), Named::One(twin_a));
        assert!(matches!(named("use the twin worktree"), Named::Nothing));
        assert!(matches!(
            named("use scratch or master"),
            Named::Unresolved(_)
        ));

        assert_eq!(named("use /elsewhere/scratch"), Named::Nothing);
        assert_eq!(
            named("tie this conversation with the worktree"),
            Named::Nothing
        );
    }

    #[tokio::test]
    async fn every_level_resolves_full_and_short_ids() {
        for level in [
            crate::types::TaskLevel::Epic,
            crate::types::TaskLevel::Ticket,
            crate::types::TaskLevel::Task,
        ] {
            let mut entity = entity(UNCACHED);
            entity.level = level;
            let project = ProjectEntities::new(vec![entity.clone()]);
            for id in [UNCACHED, &UNCACHED[..8]] {
                assert_eq!(named_entity(id, &project).await, Named::One(entity.clone()));
            }
        }
    }

    #[tokio::test]
    async fn ambiguous_short_ids_require_a_full_id() {
        let one = entity(CACHED);
        let two = entity("f6f6bf5e-0000-4000-8000-000000000000");
        let project = ProjectEntities::new(vec![one.clone(), two]);

        assert!(matches!(
            named_entity(&CACHED[..8], &project).await,
            Named::Unresolved(_)
        ));

        assert_eq!(named_entity(CACHED, &project).await, Named::One(one));
    }
}
