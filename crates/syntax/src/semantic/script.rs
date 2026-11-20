//! Turns a node mapping into the reported change list.

use super::facts::{self, ApiTable, Facts, Touched};
use super::matching::{self, Mapping};
use super::profile::Profile;
use super::tree::{NodeId, SyntaxTree};
use super::{Deadline, Edit, FallbackReason, LineSpan, Occurrence, ScopeSegment, SemanticChange};
use std::collections::BTreeMap;
use std::ops::Range;

/// Which tree a node belongs to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Old,
    New,
}

/// How far a change's facts look beyond its own nodes.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Reach {
    /// Also the nodes enclosing them, and the counterparts of all of these
    /// on the other side: what the change's nodes were or became.
    Full,
    /// Its nodes only, against nothing on the other side: a pairing
    /// artefact reported as a removal and an addition reads as one.
    Alone,
    /// Only whether it is in test code: a rename changes names, not what
    /// the code does.
    Context,
}

struct Script<'a, 's> {
    old: &'a SyntaxTree<'s>,
    new: &'a SyntaxTree<'s>,
    m: &'a Mapping,
    profile: &'static Profile,
    apis: &'a ApiTable,
    deadline: &'a Deadline,
}

pub(crate) fn changes(
    old: &SyntaxTree,
    new: &SyntaxTree,
    m: &Mapping,
    profile: &'static Profile,
    apis: &ApiTable,
    deadline: &Deadline,
) -> Result<Vec<SemanticChange>, FallbackReason> {
    let script = Script {
        old,
        new,
        m,
        profile,
        apis,
        deadline,
    };
    let mut changes = Vec::new();
    script.removals(Side::Old, &mut changes)?;
    script.removals(Side::New, &mut changes)?;
    script.updates(&mut changes)?;
    script.moves(&mut changes)?;
    changes.sort_by(|x, y| x.order_key().cmp(&y.order_key()));
    changes.dedup();
    Ok(changes)
}

impl SemanticChange {
    fn order_key(&self) -> (u32, u32, u8, &str) {
        let (old, new) = self.edit.spans();
        let primary = new.or(old).map_or(0, |span| span.start);
        let secondary = old.map_or(0, |span| span.start);
        let kind = match &self.edit {
            Edit::Delete { .. } => 0,
            Edit::Insert { .. } => 1,
            Edit::Update { .. } => 2,
            Edit::Rename { .. } => 3,
            Edit::Move { .. } => 4,
        };
        (primary, secondary, kind, &self.node_kind)
    }
}

impl<'s> Script<'_, 's> {
    fn tree(&self, side: Side) -> &SyntaxTree<'s> {
        match side {
            Side::Old => self.old,
            Side::New => self.new,
        }
    }

    fn partner(&self, side: Side, id: NodeId) -> Option<NodeId> {
        match side {
            Side::Old => self.m.partner_of_a(id),
            Side::New => self.m.partner_of_b(id),
        }
    }

    /// Topmost unmatched nodes: deletions on the old side, insertions on the new.
    fn removals(&self, side: Side, out: &mut Vec<SemanticChange>) -> Result<(), FallbackReason> {
        let tree = self.tree(side);
        let mut id = 0;
        while id < tree.len() {
            let node = &tree.nodes[id];
            if self.partner(side, id).is_some() {
                id += 1;
                continue;
            }
            if !self.is_trivia(tree, id) {
                // Adjacent unmatched siblings are one change, except that
                // each declaration is its own, with the comments and
                // attributes before it.
                let mut span = node.lines;
                let mut declared = subject(tree, id);
                let mut next = id + node.size;
                while next < tree.len()
                    && tree.nodes[next].parent == node.parent
                    && self.partner(side, next).is_none()
                    && !self.is_trivia(tree, next)
                {
                    let declares = subject(tree, next);
                    // After a declaration only its punctuation joins it;
                    // comments and attributes go with the next one, unless
                    // a blank line separates them from it (a module's doc
                    // comment is not its first item's).
                    if declared.is_some() && (declares.is_some() || tree.nodes[next].named) {
                        break;
                    }
                    if declared.is_none()
                        && declares.is_some()
                        && tree.nodes[next].lines.start > span.end + 1
                    {
                        break;
                    }
                    declared = declared.or(declares);
                    span.end = span.end.max(tree.nodes[next].lines.end);
                    next += tree.nodes[next].size;
                }
                let edit = match side {
                    Side::Old => Edit::Delete { old: span },
                    Side::New => Edit::Insert { new: span },
                };
                let facts = self.facts_on(side, id..next, Reach::Full)?;
                out.push(match declared {
                    Some(declaration) => self.declaring(edit, side, declaration, facts),
                    None => self.change(edit, side, id, facts),
                });
                id = next;
                continue;
            }
            // Matched descendants of an unmatched node are reported as moves.
            id += node.size;
        }
        Ok(())
    }

    /// A trailing comma before a closing delimiter changes nothing.
    fn is_trivia(&self, tree: &SyntaxTree, id: NodeId) -> bool {
        let node = &tree.nodes[id];
        if node.named || node.kind != "," {
            return false;
        }
        let Some(parent) = node.parent else {
            return false;
        };
        let siblings = &tree.nodes[parent].children;
        let next = siblings
            .iter()
            .position(|&s| s == id)
            .and_then(|i| siblings.get(i + 1));
        match next {
            None => true,
            Some(&next) => {
                let next = &tree.nodes[next];
                !next.named && matches!(next.kind, ")" | "]" | "}" | ">" | "|")
            }
        }
    }

    fn updates(&self, out: &mut Vec<SemanticChange>) -> Result<(), FallbackReason> {
        let mut renames: BTreeMap<(&str, &str), Vec<(NodeId, NodeId)>> = BTreeMap::new();
        for a in 0..self.old.len() {
            let Some(b) = self.m.partner_of_a(a) else {
                continue;
            };
            let (x, y) = (&self.old.nodes[a], &self.new.nodes[b]);
            if x.own == y.own {
                continue;
            }
            if x.is_leaf() && self.profile.identifiers.contains(&x.kind) {
                renames
                    .entry((self.old.text(a).trim_end(), self.new.text(b).trim_end()))
                    .or_default()
                    .push((a, b));
                continue;
            }
            let facts = self.facts(
                Some(self.subtree(Side::Old, a)),
                Some(self.subtree(Side::New, b)),
                Reach::Full,
            )?;
            out.push(self.change(
                Edit::Update {
                    old: x.lines,
                    new: y.lines,
                },
                Side::New,
                b,
                facts,
            ));
        }
        for ((from, to), sites) in renames {
            let binding = sites.iter().copied().find(|&(_, b)| {
                matches!(self.new.nodes[b].field, Some("name" | "pattern" | "left"))
            });
            // One unbound pair is as likely two unrelated names lined up
            // inside rewritten code.
            let evidence = binding.is_some() || sites.len() > 1;
            if !evidence || !self.consistent_rename(from, to, &sites)? {
                for (a, b) in sites {
                    let edit = Edit::Update {
                        old: self.old.nodes[a].lines,
                        new: self.new.nodes[b].lines,
                    };
                    let facts = self.facts(Some(a..a + 1), Some(b..b + 1), Reach::Full)?;
                    out.push(self.change(edit, Side::New, b, facts));
                }
                continue;
            }
            // Anchor on the binding (`let x`, `fn x`, `x =`) when there is one.
            let (a, b) = binding.unwrap_or(sites[0]);
            let occurrences = sites
                .iter()
                .map(|&(a, b)| Occurrence {
                    old_line: self.old.nodes[a].lines.start,
                    new_line: self.new.nodes[b].lines.start,
                })
                .collect();
            let edit = Edit::Rename {
                old: self.old.nodes[a].lines,
                new: self.new.nodes[b].lines,
                from: from.into(),
                to: to.into(),
                occurrences,
            };
            let named = self.new.nodes[b].parent.filter(|&parent| {
                self.new
                    .scopes
                    .get(&parent)
                    .is_some_and(|d| d.name_node == b)
            });
            let facts = self.facts(Some(a..a + 1), Some(b..b + 1), Reach::Context)?;
            out.push(match named {
                Some(declaration) => self.declaring(edit, Side::New, declaration, facts),
                None => self.change(edit, Side::New, b, facts),
            });
        }
        Ok(())
    }

    /// A rename only when the old name is gone from the scope enclosing all
    /// its new sites, and the new name was absent from the old scope;
    /// otherwise identifiers were merely paired up inside rewritten code.
    fn consistent_rename(
        &self,
        from: &str,
        to: &str,
        sites: &[(NodeId, NodeId)],
    ) -> Result<bool, FallbackReason> {
        let absent = |tree: &SyntaxTree, ids: &mut dyn Iterator<Item = NodeId>, name: &str| {
            let root = self.common_scope(tree, ids);
            self.deadline.tick(tree.nodes[root].size)?;
            let range = std::iter::once(root).chain(tree.nodes[root].descendants(root));
            Ok(!range.into_iter().any(|id| {
                let node = &tree.nodes[id];
                node.is_leaf()
                    && self.profile.identifiers.contains(&node.kind)
                    && tree.text(id).trim_end() == name
            }))
        };
        Ok(absent(self.new, &mut sites.iter().map(|s| s.1), from)?
            && absent(self.old, &mut sites.iter().map(|s| s.0), to)?)
    }

    /// The innermost scope node containing every id, or the root.
    fn common_scope(&self, tree: &SyntaxTree, ids: &mut dyn Iterator<Item = NodeId>) -> NodeId {
        let Some(first) = ids.next() else { return 0 };
        let rest: Vec<NodeId> = ids.collect();
        let mut cursor = tree.nodes[first].parent;
        while let Some(node) = cursor {
            let contains = |id: NodeId| tree.nodes[node].descendants(node).contains(&id);
            let container = tree.scopes.get(&node).is_some_and(|d| !d.kind.member());
            if container && rest.iter().all(|&id| contains(id)) {
                return node;
            }
            cursor = tree.nodes[node].parent;
        }
        0
    }

    fn moves(&self, out: &mut Vec<SemanticChange>) -> Result<(), FallbackReason> {
        let mut moved = Vec::new();
        for a in 0..self.old.len() {
            let Some(b) = self.m.partner_of_a(a) else {
                continue;
            };
            let (Some(pa), Some(pb)) = (self.old.nodes[a].parent, self.new.nodes[b].parent) else {
                continue;
            };
            // Wrapping or unwrapping (an unmatched parent) is reported by
            // that parent's insertion or deletion.
            if let Some(partner) = self.m.partner_of_a(pa) {
                if partner != pb && self.m.partner_of_b(pb).is_some() && self.old.nodes[a].named {
                    moved.push((a, b));
                }
            }
        }
        for a in 0..self.old.len() {
            if let Some(b) = self.m.partner_of_a(a) {
                if self.old.nodes[a].hash != self.new.nodes[b].hash {
                    moved.extend(self.reordered(a, b)?);
                }
            }
        }
        // A single token "moving", or a pair that shares little, is a
        // pairing artefact; it is reported as the removal and addition a
        // reader sees, unless it travels with the moved node it belongs to
        // on both sides: the one after it (a leading comment or attribute),
        // or the one before it on the same line (a trailing comment).
        let partners: BTreeMap<NodeId, NodeId> = moved.iter().copied().collect();
        // A comment always travels with its node when that node moved too.
        let artefact = |a: NodeId, b: NodeId| self.old.nodes[a].is_leaf() || !self.alike(a, b);
        let attached =
            |a: NodeId, b: NodeId| artefact(a, b) || self.old.nodes[a].kind.contains("comment");
        let mut spans: BTreeMap<NodeId, (NodeId, LineSpan, LineSpan)> = BTreeMap::new();
        let mut loose = Vec::new();
        for &(a, b) in moved.iter().rev() {
            self.deadline
                .tick(self.old.nodes[a].size + self.new.nodes[b].size)?;
            let trailing = self.old.trails(a) && self.new.trails(b);
            let mut target = (a, b);
            while attached(target.0, target.1) {
                let (x, y) = (self.old.siblings(target.0), self.new.siblings(target.1));
                match if trailing { (x.0, y.0) } else { (x.1, y.1) } {
                    (Some(na), Some(nb)) if partners.get(&na) == Some(&nb) => target = (na, nb),
                    _ => break,
                }
            }
            if artefact(target.0, target.1) {
                loose.push((a, b));
                continue;
            }
            let (old, new) = (self.old.nodes[a].lines, self.new.nodes[b].lines);
            let entry = spans.entry(target.0).or_insert((
                target.1,
                self.old.nodes[target.0].lines,
                self.new.nodes[target.1].lines,
            ));
            entry.1 = union(entry.1, old);
            entry.2 = union(entry.2, new);
        }
        for (a, b) in loose {
            let facts = self.facts_on(Side::Old, self.subtree(Side::Old, a), Reach::Alone)?;
            out.push(self.change(
                Edit::Delete {
                    old: self.old.nodes[a].lines,
                },
                Side::Old,
                a,
                facts,
            ));
            let facts = self.facts_on(Side::New, self.subtree(Side::New, b), Reach::Alone)?;
            out.push(self.change(
                Edit::Insert {
                    new: self.new.nodes[b].lines,
                },
                Side::New,
                b,
                facts,
            ));
        }
        for (a, (b, old, new)) in spans {
            let edit = Edit::Move { old, new };
            let facts = self.facts(
                Some(self.subtree(Side::Old, a)),
                Some(self.subtree(Side::New, b)),
                Reach::Full,
            )?;
            out.push(match subject(self.new, b) {
                Some(declaration) => self.declaring(edit, Side::New, declaration, facts),
                None => self.change(edit, Side::New, b, facts),
            });
        }
        Ok(())
    }

    /// Whether a matched pair is recognisably the same code.
    fn alike(&self, a: NodeId, b: NodeId) -> bool {
        const SAME: f64 = 0.5;
        self.old.nodes[a].hash == self.new.nodes[b].hash
            || matching::dice(self.old, self.new, self.m, a, b) >= SAME
            || matching::token_similarity(self.old, self.new, a, b) >= SAME
    }

    /// Children of a matched pair that stay matched to each other but change
    /// order: those outside the heaviest order-preserving chain moved.
    fn reordered(&self, a: NodeId, b: NodeId) -> Result<Vec<(NodeId, NodeId)>, FallbackReason> {
        let position: BTreeMap<NodeId, usize> = self.new.nodes[b]
            .children
            .iter()
            .enumerate()
            .map(|(i, &c)| (c, i))
            .collect();
        let pairs: Vec<(NodeId, NodeId, usize)> = self.old.nodes[a]
            .children
            .iter()
            .filter_map(|&x| {
                let y = self.m.partner_of_a(x)?;
                Some((x, y, *position.get(&y)?))
            })
            .collect();
        if pairs.len() < 2 || pairs.windows(2).all(|w| w[0].2 < w[1].2) {
            return Ok(Vec::new());
        }
        // Heaviest increasing chain by line count, as a line diff keeps the
        // most lines in place, so the moves reported are the blocks a line
        // diff shows as moved. Weights are symmetric in (x, y) and almost
        // never tie, so both directions keep the same chain.
        let weight = |x: NodeId, y: NodeId| -> u128 {
            let (nx, ny) = (&self.old.nodes[x], &self.new.nodes[y]);
            let lines = |span: LineSpan| u128::from(span.end - span.start + 1);
            let size = (lines(nx.lines) + lines(ny.lines)) << 32 | (nx.size + ny.size) as u128;
            (size << 64) | u128::from(nx.hash.min(ny.hash) ^ nx.hash.max(ny.hash).rotate_left(1))
        };
        const MAX_CHILDREN: usize = 2_000;
        if pairs.len() > MAX_CHILDREN {
            return Ok(Vec::new());
        }
        let items: Vec<(usize, u128)> = pairs
            .iter()
            .map(|&(x, y, position)| (position, weight(x, y)))
            .collect();
        let mut kept = vec![false; pairs.len()];
        for i in matching::heaviest_chain(&items, self.deadline)? {
            kept[i] = true;
        }
        Ok(pairs
            .iter()
            .zip(kept)
            .filter(|((x, _, _), kept)| !kept && self.old.nodes[*x].named)
            .map(|((x, y, _), _)| (*x, *y))
            .collect())
    }

    fn change(&self, edit: Edit, side: Side, id: NodeId, facts: Facts) -> SemanticChange {
        let tree = self.tree(side);
        let signature = !matches!(edit, Edit::Rename { .. }) && self.in_signature(tree, id);
        SemanticChange {
            node_kind: tree.nodes[id].kind.to_string(),
            scope: self.scope(side, id),
            signature,
            declares: false,
            facts,
            head: None,
            edit,
        }
    }

    /// A change to the declaration `id` itself: added, removed, moved or
    /// renamed as a whole.
    fn declaring(&self, edit: Edit, side: Side, id: NodeId, facts: Facts) -> SemanticChange {
        let tree = self.tree(side);
        SemanticChange {
            node_kind: tree.nodes[id].kind.to_string(),
            scope: self.scope(side, id),
            signature: false,
            declares: true,
            facts,
            head: Some(tree.nodes[id].lines.start),
            edit,
        }
    }

    /// A node and its descendants.
    fn subtree(&self, side: Side, id: NodeId) -> Range<NodeId> {
        id..id + self.tree(side).nodes[id].size
    }

    /// Facts of a change with nodes on one side only.
    fn facts_on(
        &self,
        side: Side,
        nodes: Range<NodeId>,
        reach: Reach,
    ) -> Result<Facts, FallbackReason> {
        match side {
            Side::Old => self.facts(Some(nodes), None, reach),
            Side::New => self.facts(None, Some(nodes), reach),
        }
    }

    /// The facts of a change to `old` and `new` (preorder ranges: nodes
    /// with their descendants, or adjacent siblings with theirs).
    fn facts(
        &self,
        old: Option<Range<NodeId>>,
        new: Option<Range<NodeId>>,
        reach: Reach,
    ) -> Result<Facts, FallbackReason> {
        let mut nodes: [Vec<NodeId>; 2] = [Vec::new(), Vec::new()];
        let index = |side: Side| match side {
            Side::Old => 0,
            Side::New => 1,
        };
        if reach != Reach::Context {
            for (side, range) in [(Side::Old, &old), (Side::New, &new)] {
                let Some(range) = range.clone() else {
                    continue;
                };
                let tree = self.tree(side);
                let (here, there) = (index(side), index(other(side)));
                self.deadline.tick(range.len())?;
                if reach == Reach::Full {
                    for id in range.clone() {
                        nodes[there].extend(self.partner(side, id));
                    }
                    let mut cursor = tree.nodes[range.start].parent;
                    while let Some(id) = cursor {
                        nodes[here].push(id);
                        nodes[there].extend(self.partner(side, id));
                        cursor = tree.nodes[id].parent;
                    }
                }
                nodes[here].extend(range);
            }
        }
        let roots = |tree: &SyntaxTree, range: Option<Range<NodeId>>| {
            let mut roots = Vec::new();
            if let Some(range) = range {
                let mut id = range.start;
                while id < range.end {
                    roots.push(id);
                    id += tree.nodes[id].size;
                }
            }
            roots
        };
        let [mut old_nodes, mut new_nodes] = nodes;
        for nodes in [&mut old_nodes, &mut new_nodes] {
            nodes.sort_unstable();
            nodes.dedup();
        }
        let old = Touched {
            tree: self.old,
            nodes: old_nodes,
            roots: roots(self.old, old),
        };
        let new = Touched {
            tree: self.new,
            nodes: new_nodes,
            roots: roots(self.new, new),
        };
        Ok(facts::derive([&old, &new], self.apis))
    }

    /// Enclosing scopes, outermost first, including the node itself.
    fn scope(&self, side: Side, id: NodeId) -> Vec<ScopeSegment> {
        let tree = self.tree(side);
        let mut segments = Vec::new();
        let mut cursor = Some(id);
        while let Some(node) = cursor {
            if let Some(meta) = tree.scopes.get(&node) {
                let here = tree.nodes[node].lines.start;
                let there = self
                    .partner(side, node)
                    .map(|p| self.tree(other(side)).nodes[p].lines.start);
                let (old_line, new_line) = match side {
                    Side::Old => (Some(here), there),
                    Side::New => (there, Some(here)),
                };
                segments.push(ScopeSegment {
                    kind: meta.kind,
                    keyword: meta.keyword.clone(),
                    name: meta.name.clone(),
                    old_line,
                    new_line,
                });
            }
            cursor = tree.nodes[node].parent;
        }
        segments.reverse();
        segments
    }

    /// Whether a node sits in a callable's header (before its body).
    fn in_signature(&self, tree: &SyntaxTree, id: NodeId) -> bool {
        let mut cursor = tree.nodes[id].parent;
        while let Some(node) = cursor {
            if let Some(meta) = tree.scopes.get(&node) {
                if !meta.kind.callable() {
                    return false;
                }
                return match tree.body(node) {
                    Some(body) => tree.nodes[id].bytes.end <= tree.nodes[body].bytes.start,
                    None => true,
                };
            }
            cursor = tree.nodes[node].parent;
        }
        false
    }
}

fn other(side: Side) -> Side {
    match side {
        Side::Old => Side::New,
        Side::New => Side::Old,
    }
}

/// The declaration a node is, or wraps: `export function f`, `const f =
/// () => {}`, a decorated Python `def`. Wrappers hold the declaration as
/// their last named child; a block or body holding one is code, not a
/// wrapper.
fn subject(tree: &SyntaxTree, id: NodeId) -> Option<NodeId> {
    const DEPTH: usize = 2;
    let mut cursor = id;
    for _ in 0..=DEPTH {
        if tree.scopes.contains_key(&cursor) {
            return Some(cursor);
        }
        let node = &tree.nodes[cursor];
        if node.kind.contains("block") || node.kind.contains("body") {
            return None;
        }
        cursor = node.children.iter().rev().copied().find(|&child| {
            tree.nodes[child].named && !tree.nodes[child].kind.contains("comment")
        })?;
        let field = tree.nodes[cursor].field;
        if matches!(field, Some("body" | "consequence" | "alternative")) {
            return None;
        }
    }
    None
}

fn union(a: LineSpan, b: LineSpan) -> LineSpan {
    LineSpan {
        start: a.start.min(b.start),
        end: a.end.max(b.end),
    }
}
