//! A flattened, preorder copy of a tree-sitter tree with the structural
//! hashes, heights and sizes the matcher needs. Node `i`'s descendants are
//! exactly the ids `i + 1 .. i + size`.

use super::profile::Declarations;
use super::{Deadline, DeclarationKind, FallbackReason, LineSpan};
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::ops::Range;
use tree_sitter::{QueryCursor, StreamingIterator, Tree};

pub(crate) type NodeId = usize;

pub(crate) struct Node {
    pub(crate) kind: &'static str,
    pub(crate) kind_id: u16,
    pub(crate) named: bool,
    pub(crate) parent: Option<NodeId>,
    pub(crate) children: Vec<NodeId>,
    /// This node's field name in its parent.
    pub(crate) field: Option<&'static str>,
    pub(crate) bytes: Range<usize>,
    pub(crate) lines: LineSpan,
    /// Kind, leaf text and children; equal hashes mean isomorphic subtrees.
    pub(crate) hash: u64,
    /// Non-whitespace text between children (or the leaf text): what the
    /// node itself contributes beyond its children.
    pub(crate) own: u64,
    pub(crate) height: u32,
    /// Nodes in this subtree, itself included.
    pub(crate) size: usize,
}

impl Node {
    pub(crate) fn is_leaf(&self) -> bool {
        self.children.is_empty()
    }

    pub(crate) fn descendants(&self, id: NodeId) -> Range<NodeId> {
        id + 1..id + self.size
    }
}

/// A declaration node: what it declares and how to label it.
pub(crate) struct Declaration {
    pub(crate) kind: DeclarationKind,
    pub(crate) keyword: &'static str,
    pub(crate) name: String,
    /// The node holding the name.
    pub(crate) name_node: NodeId,
}

pub(crate) struct SyntaxTree<'s> {
    pub(crate) source: &'s str,
    pub(crate) nodes: Vec<Node>,
    pub(crate) scopes: HashMap<NodeId, Declaration>,
}

/// Tokens that qualify a declaration rather than name its kind.
const MODIFIERS: &[&str] = &[
    "abstract",
    "accessor",
    "async",
    "declare",
    "default",
    "export",
    "extern",
    "override",
    "private",
    "protected",
    "public",
    "readonly",
    "static",
    "unsafe",
];

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0100_0000_01b3;

fn fnv(bytes: impl IntoIterator<Item = u8>, seed: u64) -> u64 {
    bytes.into_iter().fold(seed, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
    })
}

fn mix(hash: u64, value: u64) -> u64 {
    (hash.rotate_left(17) ^ value).wrapping_mul(FNV_PRIME)
}

/// The bytes of text between a node's children that count: all of them in
/// a literal, otherwise all but whitespace.
fn content(text: &str, literal: bool) -> impl Iterator<Item = u8> + '_ {
    text.bytes()
        .filter(move |byte| literal || !byte.is_ascii_whitespace())
}

impl<'s> SyntaxTree<'s> {
    pub(crate) fn build(
        source: &'s str,
        syntax: &Tree,
        declarations: &Declarations,
        literals: &[&str],
        max_nodes: usize,
        deadline: &Deadline,
    ) -> Result<Self, FallbackReason> {
        let mut nodes: Vec<Node> = Vec::new();
        // tree-sitter node ids to arena ids, for query captures.
        let mut ids: HashMap<usize, NodeId> = HashMap::new();
        let mut parents: Vec<NodeId> = Vec::new();
        let mut cursor = syntax.walk();

        loop {
            let node = cursor.node();
            let id = nodes.len();
            if id >= max_nodes {
                return Err(FallbackReason::TooLarge);
            }
            if id.is_multiple_of(1024) {
                deadline.check()?;
            }
            let start = node.start_position();
            let end = node.end_position();
            // A node ending at column 0 ends on the line before.
            let end_row = if end.column == 0 && end.row > start.row {
                end.row
            } else {
                end.row + 1
            };
            let parent = parents.last().copied();
            ids.insert(node.id(), id);
            nodes.push(Node {
                kind: node.kind(),
                kind_id: node.kind_id(),
                named: node.is_named(),
                parent,
                children: Vec::new(),
                field: cursor.field_name(),
                bytes: node.byte_range(),
                lines: LineSpan::new(line(start.row + 1), line(end_row.max(start.row + 1))),
                hash: 0,
                own: 0,
                height: 1,
                size: 1,
            });
            if let Some(parent) = parent {
                nodes[parent].children.push(id);
            }
            if cursor.goto_first_child() {
                parents.push(id);
                continue;
            }
            loop {
                if cursor.goto_next_sibling() {
                    break;
                }
                if !cursor.goto_parent() {
                    let mut tree = Self {
                        source,
                        nodes,
                        scopes: HashMap::new(),
                    };
                    tree.summarize(literals);
                    tree.scopes = tree.find_scopes(syntax, declarations, &ids, deadline)?;
                    return Ok(tree);
                }
                parents.pop();
            }
        }
    }

    /// Hashes, heights and sizes, children before parents. Whitespace is
    /// layout except inside a string or character literal (`literals`),
    /// where it is the literal's content.
    fn summarize(&mut self, literals: &[&str]) {
        for id in (0..self.nodes.len()).rev() {
            let node = &self.nodes[id];
            let kind_seed = mix(FNV_OFFSET, u64::from(node.kind_id));
            let literal = literals.contains(&node.kind);
            if node.is_leaf() {
                let in_literal = literal
                    || node
                        .parent
                        .is_some_and(|parent| literals.contains(&self.nodes[parent].kind));
                let text = self.text(id);
                let text = if in_literal { text } else { text.trim_end() };
                let own = fnv(text.bytes(), FNV_OFFSET);
                let node = &mut self.nodes[id];
                node.own = own;
                node.hash = mix(kind_seed, own);
                continue;
            }
            let mut hash = kind_seed;
            let mut own = FNV_OFFSET;
            let mut height = 0;
            let mut size = 1;
            let mut cursor = node.bytes.start;
            for &child in &node.children {
                let child = &self.nodes[child];
                own = fnv(
                    content(&self.source[cursor..child.bytes.start.max(cursor)], literal),
                    own,
                );
                cursor = cursor.max(child.bytes.end);
                hash = mix(hash, child.hash);
                height = height.max(child.height);
                size += child.size;
            }
            own = fnv(
                content(&self.source[cursor..node.bytes.end.max(cursor)], literal),
                own,
            );
            let node = &mut self.nodes[id];
            node.own = own;
            node.hash = mix(hash, own);
            node.height = height + 1;
            node.size = size;
        }
    }

    /// Declarations by node: the tags query's `@definition.*` captures,
    /// the most specific kind winning where one node is captured twice.
    fn find_scopes(
        &self,
        syntax: &Tree,
        declarations: &Declarations,
        ids: &HashMap<usize, NodeId>,
        deadline: &Deadline,
    ) -> Result<HashMap<NodeId, Declaration>, FallbackReason> {
        let mut found: HashMap<NodeId, (DeclarationKind, NodeId)> = HashMap::new();
        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(
            &declarations.query,
            syntax.root_node(),
            self.source.as_bytes(),
        );
        let mut seen: usize = 0;
        while let Some(found_match) = matches.next() {
            seen += 1;
            if seen.is_multiple_of(256) {
                deadline.check()?;
            }
            let mut name = None;
            let mut declaration = None;
            for capture in found_match.captures {
                if capture.index == declarations.name {
                    name = ids.get(&capture.node.id()).copied();
                } else if let Some(Some(kind)) = declarations.kinds.get(capture.index as usize) {
                    declaration = ids.get(&capture.node.id()).map(|&id| (*kind, id));
                }
            }
            let (Some(name), Some((kind, id))) = (name, declaration) else {
                continue;
            };
            match found.entry(id) {
                Entry::Vacant(entry) => {
                    entry.insert((kind, name));
                }
                Entry::Occupied(mut entry) if kind.precedence() < entry.get().0.precedence() => {
                    entry.insert((kind, name));
                }
                Entry::Occupied(_) => {}
            }
        }
        Ok(found
            .into_iter()
            .map(|(id, (kind, name_node))| {
                let name = self
                    .text(name_node)
                    .trim_matches(|c| matches!(c, '"' | '\'' | '`'));
                // A trait impl reads as `Display for Account`.
                let name = match self.field_child(id, "trait") {
                    Some(t) if kind == DeclarationKind::Impl => {
                        format!("{} for {name}", self.text(t))
                    }
                    _ => name.to_owned(),
                };
                let declaration = Declaration {
                    kind,
                    keyword: self.keyword(id, name_node, kind),
                    name: display_name(&name),
                    name_node,
                };
                (id, declaration)
            })
            .collect())
    }

    /// The first keyword token before a declaration's name (`fn`, `class`,
    /// `def`), else before the declaration in its parent (`const` for a
    /// declarator), else a word for the kind.
    fn keyword(&self, id: NodeId, name: NodeId, kind: DeclarationKind) -> &'static str {
        let words = |parent: NodeId, before: usize| {
            self.nodes[parent]
                .children
                .iter()
                .map(|&child| &self.nodes[child])
                .filter(move |child| {
                    !child.named
                        && child.bytes.start < before
                        && child.kind.starts_with(|c: char| c.is_ascii_alphabetic())
                })
                .map(|child| child.kind)
        };
        let keyword = |parent: NodeId, before: usize| {
            words(parent, before).find(|word| !MODIFIERS.contains(word))
        };
        keyword(id, self.nodes[name].bytes.start)
            .or_else(|| {
                let parent = self.nodes[id].parent?;
                keyword(parent, self.nodes[id].bytes.start)
            })
            // Rust's `static` is a declaration keyword, not a modifier.
            .or_else(|| {
                (kind == DeclarationKind::Constant)
                    .then(|| words(id, self.nodes[name].bytes.start).next())
                    .flatten()
            })
            .unwrap_or(kind.word())
    }

    pub(crate) fn text(&self, id: NodeId) -> &'s str {
        let bytes = &self.nodes[id].bytes;
        self.source.get(bytes.clone()).unwrap_or_default()
    }

    pub(crate) fn field_child(&self, id: NodeId, field: &str) -> Option<NodeId> {
        self.nodes[id]
            .children
            .iter()
            .copied()
            .find(|&child| self.nodes[child].field == Some(field))
    }

    /// The scope body: its `body` field, or its value's (`const f = () => {}`,
    /// `exports.f = () => {}`).
    pub(crate) fn body(&self, id: NodeId) -> Option<NodeId> {
        self.field_child(id, "body").or_else(|| {
            self.field_child(id, "value")
                .or_else(|| self.field_child(id, "right"))
                .and_then(|value| self.field_child(value, "body"))
        })
    }

    pub(crate) fn len(&self) -> usize {
        self.nodes.len()
    }

    /// The siblings before and after a node.
    pub(crate) fn siblings(&self, id: NodeId) -> (Option<NodeId>, Option<NodeId>) {
        let Some(parent) = self.nodes[id].parent else {
            return (None, None);
        };
        let children = &self.nodes[parent].children;
        let Some(i) = children.iter().position(|&c| c == id) else {
            return (None, None);
        };
        (
            i.checked_sub(1).map(|j| children[j]),
            children.get(i + 1).copied(),
        )
    }

    /// Whether a node starts on the line where the sibling before it ends
    /// (a trailing comment), so it belongs with that sibling rather than
    /// the next.
    pub(crate) fn trails(&self, id: NodeId) -> bool {
        self.siblings(id)
            .0
            .is_some_and(|previous| self.nodes[previous].lines.end == self.nodes[id].lines.start)
    }
}

fn line(row: usize) -> u32 {
    u32::try_from(row).unwrap_or(u32::MAX)
}

/// Collapse whitespace and keep names short enough for a label.
fn display_name(text: &str) -> String {
    const MAX: usize = 80;
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match collapsed.char_indices().nth(MAX) {
        Some((cut, _)) => format!("{}…", &collapsed[..cut]),
        None => collapsed,
    }
}
