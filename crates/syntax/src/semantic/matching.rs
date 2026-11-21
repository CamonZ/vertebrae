//! GumTree-style node matching between two syntax trees:
//!
//! 1. top-down: identical subtrees, tallest first; unique hashes match
//!    directly, repeated ones by how alike their parents are;
//! 2. bottom-up: unmatched containers whose descendants mostly matched each
//!    other (dice ≥ 0.5), or declarations of the same kind and name;
//! 3. recovery: unmatched children of matched parents: identical ones
//!    beside matched neighbours, then identical ones in order, then by kind
//!    and similarity.
//!
//! Every greedy choice goes through [`accept_symmetric`], which ranks pairs by
//! keys that do not depend on which side is "old", so matching `b` against
//! `a` yields the mirror of matching `a` against `b`.

use super::tree::{NodeId, SyntaxTree};
use super::{Deadline, FallbackReason};
use std::cmp::Reverse;
use std::collections::{BTreeMap, HashMap, HashSet};

/// Subtrees shorter than this are left to recovery (GumTree's min height):
/// single tokens are too common to match on their own.
const MIN_HEIGHT: u32 = 2;
const MIN_DICE: f64 = 0.5;
/// Candidate pairs considered for one group of repeated subtrees.
const MAX_AMBIGUOUS: usize = 4096;
const SCALE: f64 = 1_000_000.0;

pub(crate) struct Mapping {
    pub(crate) a_to_b: Vec<Option<NodeId>>,
    pub(crate) b_to_a: Vec<Option<NodeId>>,
}

impl Mapping {
    fn new(a: usize, b: usize) -> Self {
        Self {
            a_to_b: vec![None; a],
            b_to_a: vec![None; b],
        }
    }

    pub(crate) fn partner_of_a(&self, id: NodeId) -> Option<NodeId> {
        self.a_to_b[id]
    }

    pub(crate) fn partner_of_b(&self, id: NodeId) -> Option<NodeId> {
        self.b_to_a[id]
    }

    fn free(&self, a: NodeId, b: NodeId) -> bool {
        self.a_to_b[a].is_none() && self.b_to_a[b].is_none()
    }

    fn link(&mut self, a: NodeId, b: NodeId) {
        self.a_to_b[a] = Some(b);
        self.b_to_a[b] = Some(a);
    }

    /// Isomorphic subtrees share their preorder shape.
    fn link_subtree(&mut self, ta: &SyntaxTree, a: NodeId, b: NodeId) {
        for offset in 0..ta.nodes[a].size {
            self.link(a + offset, b + offset);
        }
    }
}

/// `2 · common / (|desc a| + |desc b|)`, where common descendants are matched
/// to each other.
pub(crate) fn dice(ta: &SyntaxTree, tb: &SyntaxTree, m: &Mapping, a: NodeId, b: NodeId) -> f64 {
    let (da, db) = (ta.nodes[a].descendants(a), tb.nodes[b].descendants(b));
    let total = da.len() + db.len();
    if total == 0 {
        return 0.0;
    }
    let common = da
        .filter(|&d| m.a_to_b[d].is_some_and(|p| db.contains(&p)))
        .count();
    2.0 * common as f64 / total as f64
}

/// Overlap of named leaf tokens (names, literals; not punctuation or
/// keywords), for subtrees with no matched descendants.
pub(crate) fn token_similarity(ta: &SyntaxTree, tb: &SyntaxTree, a: NodeId, b: NodeId) -> f64 {
    const MAX_TOKENS: usize = 4096;
    let leaves = |t: &SyntaxTree, id: NodeId| -> Option<Vec<u64>> {
        let node = &t.nodes[id];
        if node.size > MAX_TOKENS {
            return None;
        }
        let mut hashes: Vec<u64> = std::iter::once(id)
            .chain(node.descendants(id))
            .filter(|&d| t.nodes[d].is_leaf() && t.nodes[d].named)
            .map(|d| t.nodes[d].hash)
            .collect();
        hashes.sort_unstable();
        Some(hashes)
    };
    let (Some(x), Some(y)) = (leaves(ta, a), leaves(tb, b)) else {
        return 0.0;
    };
    if x.is_empty() && y.is_empty() {
        return 0.0;
    }
    let (mut i, mut j, mut common) = (0, 0, 0usize);
    while i < x.len() && j < y.len() {
        match x[i].cmp(&y[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                common += 1;
                i += 1;
                j += 1;
            }
        }
    }
    2.0 * common as f64 / (x.len() + y.len()) as f64
}

/// Prefer the line that retains the wording when a comment is reflowed.
fn comment_similarity(old: &str, new: &str) -> f64 {
    fn words(text: &str) -> HashSet<&str> {
        text.split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .filter(|word| !word.is_empty())
            .collect()
    }

    const MAX_BYTES: usize = 4096;
    if old.len() > MAX_BYTES || new.len() > MAX_BYTES {
        return 0.0;
    }
    let (old, new) = (words(old), words(new));
    let total = old.len() + new.len();
    if total == 0 {
        return 0.0;
    }
    2.0 * old.intersection(&new).count() as f64 / total as f64
}

/// How many of a pair's adjacent siblings are matched to each other: the
/// context that tells repeated subtrees (`#[test]`, `return;`) apart. The
/// sibling a node belongs with counts double when both sides agree on it:
/// the next one for a node on its own line (a leading comment or
/// attribute), the previous one for a node on the line where that one ends
/// (a trailing comment).
fn aligned_neighbors(ta: &SyntaxTree, tb: &SyntaxTree, m: &Mapping, a: NodeId, b: NodeId) -> u64 {
    let ((pa, na), (pb, nb)) = (ta.siblings(a), tb.siblings(b));
    let linked = |x: Option<NodeId>, y: Option<NodeId>| match (x, y) {
        (Some(x), Some(y)) => u64::from(m.a_to_b[x] == Some(y)),
        _ => 0,
    };
    let (trailing_a, trailing_b) = (ta.trails(a), tb.trails(b));
    let previous_weight = 1 + u64::from(trailing_a && trailing_b);
    let next_weight = 1 + u64::from(!trailing_a && !trailing_b);
    previous_weight * linked(pa, pb) + next_weight * linked(na, nb)
}

fn scaled(value: f64) -> u64 {
    (value * SCALE).round() as u64
}

/// Accepts candidate pairs in key order. Pairs with equal keys are decided
/// together: a pair that competes with another of the same key for a node
/// is dropped rather than resolved by input order, which keeps the result
/// symmetric. Returns how many pairs were accepted.
fn accept_symmetric<K: Ord>(
    mut candidates: Vec<(K, NodeId, NodeId)>,
    m: &mut Mapping,
    mut accept: impl FnMut(&mut Mapping, NodeId, NodeId),
) -> usize {
    candidates.sort_by(|x, y| x.0.cmp(&y.0).then(x.1.cmp(&y.1)).then(x.2.cmp(&y.2)));
    let mut accepted = 0;
    let mut start = 0;
    while start < candidates.len() {
        let mut end = start + 1;
        while end < candidates.len() && candidates[end].0 == candidates[start].0 {
            end += 1;
        }
        let group: Vec<_> = candidates[start..end]
            .iter()
            .filter(|(_, a, b)| m.free(*a, *b))
            .map(|(_, a, b)| (*a, *b))
            .collect();
        let mut a_count: HashMap<NodeId, usize> = HashMap::new();
        let mut b_count: HashMap<NodeId, usize> = HashMap::new();
        for (a, b) in &group {
            *a_count.entry(*a).or_default() += 1;
            *b_count.entry(*b).or_default() += 1;
        }
        for (a, b) in group {
            if a_count[&a] == 1 && b_count[&b] == 1 {
                accept(m, a, b);
                accepted += 1;
            }
        }
        start = end;
    }
    accepted
}

/// How a candidate pair ranks, best first, field by field: a shared name,
/// then similarity, then matched neighbours, then how close the pair sits
/// (relative position among siblings, preorder distance, and the sum, which
/// is symmetric). Every phase uses the fields it has; the rest stay zero.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Rank {
    named: Reverse<bool>,
    similarity: Reverse<u64>,
    neighbors: Reverse<u64>,
    position: usize,
    distance: usize,
    sum: usize,
}

impl Rank {
    fn new(a: NodeId, b: NodeId) -> Self {
        Self {
            named: Reverse(false),
            similarity: Reverse(0),
            neighbors: Reverse(0),
            position: 0,
            distance: a.abs_diff(b),
            sum: a + b,
        }
    }
}

/// The heaviest chain of items increasing in both orders. `items` come in
/// one side's order, each with its position on the other side and a weight;
/// returns the chain's indices into `items`, in order. Quadratic, so it
/// reports its work to the deadline.
pub(crate) fn heaviest_chain(
    items: &[(usize, u128)],
    deadline: &Deadline,
) -> Result<Vec<usize>, FallbackReason> {
    let mut best: Vec<u128> = items.iter().map(|&(_, weight)| weight).collect();
    let mut previous: Vec<Option<usize>> = vec![None; items.len()];
    for i in 0..items.len() {
        deadline.tick(i)?;
        for j in 0..i {
            let extended = best[j].saturating_add(items[i].1);
            if items[j].0 < items[i].0 && extended > best[i] {
                best[i] = extended;
                previous[i] = Some(j);
            }
        }
    }
    let mut chain = Vec::new();
    let mut cursor = (0..items.len()).max_by_key(|&i| best[i]);
    while let Some(i) = cursor {
        chain.push(i);
        cursor = previous[i];
    }
    chain.reverse();
    Ok(chain)
}

pub(crate) fn match_trees(
    ta: &SyntaxTree,
    tb: &SyntaxTree,
    deadline: &Deadline,
) -> Result<Mapping, FallbackReason> {
    let mut m = Mapping::new(ta.len(), tb.len());
    top_down(ta, tb, &mut m, deadline)?;
    if m.free(0, 0) && ta.nodes[0].kind_id == tb.nodes[0].kind_id {
        m.link(0, 0);
    }
    // Declarations anchor first so their bodies align inside the right
    // parent before similarity alone pairs containers.
    anchor_declarations(ta, tb, &mut m, deadline)?;
    recover(ta, tb, &mut m, deadline)?;
    bottom_up(ta, tb, &mut m, deadline)?;
    recover(ta, tb, &mut m, deadline)?;
    Ok(m)
}

/// Names of the scopes enclosing a node, innermost first.
fn scope_path<'t>(tree: &'t SyntaxTree, id: NodeId) -> Vec<&'t str> {
    let mut names = Vec::new();
    let mut cursor = tree.nodes[id].parent;
    while let Some(node) = cursor {
        if let Some(meta) = tree.scopes.get(&node) {
            names.push(meta.name.as_str());
        }
        cursor = tree.nodes[node].parent;
    }
    names
}

/// Unmatched declarations of one kind and name, where both sit under the
/// same named scopes or already share part of their contents.
fn anchor_declarations(
    ta: &SyntaxTree,
    tb: &SyntaxTree,
    m: &mut Mapping,
    deadline: &Deadline,
) -> Result<(), FallbackReason> {
    let mut named: BTreeMap<(u16, &str), Vec<NodeId>> = BTreeMap::new();
    for (&id, meta) in &tb.scopes {
        if !meta.name.is_empty() && m.b_to_a[id].is_none() {
            named
                .entry((tb.nodes[id].kind_id, meta.name.as_str()))
                .or_default()
                .push(id);
        }
    }
    let mut candidates = Vec::new();
    for (&a, meta) in &ta.scopes {
        if meta.name.is_empty() || m.a_to_b[a].is_some() {
            continue;
        }
        let Some(ids) = named.get(&(ta.nodes[a].kind_id, meta.name.as_str())) else {
            continue;
        };
        for &b in ids {
            deadline.tick(ta.nodes[a].size + tb.nodes[b].size)?;
            let similarity = dice(ta, tb, m, a, b);
            let placed = scope_path(ta, a) == scope_path(tb, b);
            if placed || similarity >= 0.2 {
                let rank = Rank {
                    named: Reverse(placed),
                    similarity: Reverse(scaled(similarity)),
                    ..Rank::new(a, b)
                };
                candidates.push((rank, a, b));
            }
        }
    }
    accept_symmetric(candidates, m, Mapping::link);
    Ok(())
}

/// Unmatched nodes of one tree, tallest first.
struct HeightQueue {
    by_height: BTreeMap<u32, Vec<NodeId>>,
}

impl HeightQueue {
    fn new(root: NodeId, tree: &SyntaxTree) -> Self {
        let mut queue = Self {
            by_height: BTreeMap::new(),
        };
        queue.push(root, tree);
        queue
    }

    fn push(&mut self, id: NodeId, tree: &SyntaxTree) {
        self.by_height
            .entry(tree.nodes[id].height)
            .or_default()
            .push(id);
    }

    fn max(&self) -> u32 {
        self.by_height.keys().next_back().copied().unwrap_or(0)
    }

    fn pop_max(&mut self) -> Vec<NodeId> {
        self.by_height
            .pop_last()
            .map(|(_, ids)| ids)
            .unwrap_or_default()
    }

    fn open(&mut self, id: NodeId, tree: &SyntaxTree) {
        for &child in &tree.nodes[id].children {
            self.push(child, tree);
        }
    }
}

fn top_down(
    ta: &SyntaxTree,
    tb: &SyntaxTree,
    m: &mut Mapping,
    deadline: &Deadline,
) -> Result<(), FallbackReason> {
    let mut qa = HeightQueue::new(0, ta);
    let mut qb = HeightQueue::new(0, tb);
    let mut ambiguous: Vec<(NodeId, NodeId)> = Vec::new();

    while qa.max().min(qb.max()) >= MIN_HEIGHT {
        deadline.check()?;
        let (ha, hb) = (qa.max(), qb.max());
        if ha != hb {
            if ha > hb {
                for id in qa.pop_max() {
                    qa.open(id, ta);
                }
            } else {
                for id in qb.pop_max() {
                    qb.open(id, tb);
                }
            }
            continue;
        }
        let (level_a, level_b) = (qa.pop_max(), qb.pop_max());
        let mut groups: BTreeMap<u64, (Vec<NodeId>, Vec<NodeId>)> = BTreeMap::new();
        for &id in &level_a {
            groups.entry(ta.nodes[id].hash).or_default().0.push(id);
        }
        for &id in &level_b {
            groups.entry(tb.nodes[id].hash).or_default().1.push(id);
        }
        let mut kept_a = HashSet::new();
        let mut kept_b = HashSet::new();
        for (xs, ys) in groups.values() {
            match (xs.as_slice(), ys.as_slice()) {
                ([x], [y]) => m.link_subtree(ta, *x, *y),
                (xs, ys)
                    if !xs.is_empty() && !ys.is_empty() && xs.len() * ys.len() <= MAX_AMBIGUOUS =>
                {
                    for &x in xs {
                        for &y in ys {
                            ambiguous.push((x, y));
                        }
                    }
                    kept_a.extend(xs.iter().copied());
                    kept_b.extend(ys.iter().copied());
                }
                _ => {}
            }
        }
        for id in level_a {
            if m.a_to_b[id].is_none() && !kept_a.contains(&id) {
                qa.open(id, ta);
            }
        }
        for id in level_b {
            if m.b_to_a[id].is_none() && !kept_b.contains(&id) {
                qb.open(id, tb);
            }
        }
    }

    let mut candidates = Vec::with_capacity(ambiguous.len());
    for (a, b) in ambiguous {
        let parents = match (ta.nodes[a].parent, tb.nodes[b].parent) {
            (Some(pa), Some(pb)) => {
                deadline.tick(ta.nodes[pa].size + tb.nodes[pb].size)?;
                dice(ta, tb, m, pa, pb)
            }
            _ => 0.0,
        };
        let rank = Rank {
            similarity: Reverse(scaled(parents)),
            neighbors: Reverse(aligned_neighbors(ta, tb, m, a, b)),
            ..Rank::new(a, b)
        };
        candidates.push((rank, a, b));
    }
    accept_symmetric(candidates, m, |m, a, b| m.link_subtree(ta, a, b));
    Ok(())
}

fn renamed_declaration(ta: &SyntaxTree, tb: &SyntaxTree, a: NodeId, b: NodeId) -> bool {
    match (ta.scopes.get(&a), tb.scopes.get(&b)) {
        (Some(x), Some(y)) => x.name != y.name,
        _ => false,
    }
}

fn same_name(ta: &SyntaxTree, tb: &SyntaxTree, a: NodeId, b: NodeId) -> bool {
    match (ta.scopes.get(&a), tb.scopes.get(&b)) {
        (Some(x), Some(y)) => !x.name.is_empty() && x.name == y.name,
        _ => false,
    }
}

fn bottom_up(
    ta: &SyntaxTree,
    tb: &SyntaxTree,
    m: &mut Mapping,
    deadline: &Deadline,
) -> Result<(), FallbackReason> {
    // Matches from one round let enclosing containers match in the next.
    for _ in 0..3 {
        let mut candidates = Vec::new();
        for a in 0..ta.len() {
            deadline.tick(1)?;
            let node = &ta.nodes[a];
            if node.is_leaf() || m.a_to_b[a].is_some() {
                continue;
            }
            let mut seen = HashSet::new();
            for d in node.descendants(a) {
                deadline.tick(1)?;
                let Some(mut up) = m.a_to_b[d].and_then(|p| tb.nodes[p].parent) else {
                    continue;
                };
                while seen.insert(up) {
                    deadline.tick(1)?;
                    if tb.nodes[up].kind_id == node.kind_id && m.b_to_a[up].is_none() {
                        deadline.tick(node.size + tb.nodes[up].size)?;
                        let similarity = dice(ta, tb, m, a, up);
                        if similarity >= MIN_DICE {
                            let rank = Rank {
                                named: Reverse(same_name(ta, tb, a, up)),
                                similarity: Reverse(scaled(similarity)),
                                ..Rank::new(a, up)
                            };
                            candidates.push((rank, a, up));
                        }
                    }
                    match tb.nodes[up].parent {
                        Some(next) => up = next,
                        None => break,
                    }
                }
            }
        }
        if accept_symmetric(candidates, m, Mapping::link) == 0 {
            break;
        }
    }
    Ok(())
}

/// Children with their position among the free children of one parent.
type Indexed = Vec<(usize, NodeId)>;

/// Pairs the unmatched children of every matched pair, parents first, so
/// newly matched children are recovered in turn.
fn recover(
    ta: &SyntaxTree,
    tb: &SyntaxTree,
    m: &mut Mapping,
    deadline: &Deadline,
) -> Result<(), FallbackReason> {
    // Ids ascend in preorder: children are visited after their parent.
    for a in 0..ta.len() {
        deadline.tick(1)?;
        let Some(b) = m.a_to_b[a] else { continue };
        if ta.nodes[a].hash == tb.nodes[b].hash && ta.nodes[a].size == tb.nodes[b].size {
            continue;
        }
        let free_a: Vec<_> = ta.nodes[a]
            .children
            .iter()
            .copied()
            .filter(|&c| m.a_to_b[c].is_none())
            .collect();
        let free_b: Vec<_> = tb.nodes[b]
            .children
            .iter()
            .copied()
            .filter(|&c| m.b_to_a[c].is_none())
            .collect();
        if free_a.is_empty() || free_b.is_empty() {
            continue;
        }
        // Identical children beside matched neighbours pair first: a
        // comment or attribute stays with the declaration it sits next to.
        let mut identical: BTreeMap<u64, (Vec<NodeId>, Vec<NodeId>)> = BTreeMap::new();
        for &x in &free_a {
            identical.entry(ta.nodes[x].hash).or_default().0.push(x);
        }
        for &y in &free_b {
            identical.entry(tb.nodes[y].hash).or_default().1.push(y);
        }
        let mut beside = Vec::new();
        for (xs, ys) in identical.values() {
            if xs.len() * ys.len() > MAX_AMBIGUOUS {
                continue;
            }
            for &x in xs {
                for &y in ys {
                    deadline.tick(1)?;
                    let neighbors = aligned_neighbors(ta, tb, m, x, y);
                    if neighbors > 0 {
                        let rank = Rank {
                            neighbors: Reverse(neighbors),
                            ..Rank::new(x, y)
                        };
                        beside.push((rank, x, y));
                    }
                }
            }
        }
        accept_symmetric(beside, m, |m, x, y| m.link_subtree(ta, x, y));
        let free_a: Vec<_> = free_a
            .into_iter()
            .filter(|&c| m.a_to_b[c].is_none())
            .collect();
        let free_b: Vec<_> = free_b
            .into_iter()
            .filter(|&c| m.b_to_a[c].is_none())
            .collect();
        // Then identical children in order (long token trees, lists).
        for (x, y) in patience(ta, tb, &free_a, &free_b, deadline)? {
            m.link_subtree(ta, x, y);
        }
        let free_a: Vec<_> = free_a
            .into_iter()
            .filter(|&c| m.a_to_b[c].is_none())
            .collect();
        let free_b: Vec<_> = free_b
            .into_iter()
            .filter(|&c| m.b_to_a[c].is_none())
            .collect();
        if free_a.is_empty() || free_b.is_empty() {
            continue;
        }
        let mut by_kind: BTreeMap<u16, (Indexed, Indexed)> = BTreeMap::new();
        for (index, &c) in free_a.iter().enumerate() {
            by_kind
                .entry(ta.nodes[c].kind_id)
                .or_default()
                .0
                .push((index, c));
        }
        for (index, &c) in free_b.iter().enumerate() {
            by_kind
                .entry(tb.nodes[c].kind_id)
                .or_default()
                .1
                .push((index, c));
        }
        for (xs, ys) in by_kind.values() {
            if xs.is_empty() || ys.is_empty() || xs.len() * ys.len() > MAX_AMBIGUOUS {
                continue;
            }
            let one_to_one = xs.len() == 1 && ys.len() == 1;
            let mut candidates = Vec::new();
            for &(i, x) in xs {
                for &(j, y) in ys {
                    let (nx, ny) = (&ta.nodes[x], &tb.nodes[y]);
                    deadline.tick(nx.size + ny.size)?;
                    let similarity = if nx.is_comment() && ny.is_comment() {
                        comment_similarity(ta.text(x), tb.text(y))
                    } else if nx.is_leaf() && ny.is_leaf() {
                        f64::from(u8::from(nx.own == ny.own))
                    } else {
                        dice(ta, tb, m, x, y).max(token_similarity(ta, tb, x, y))
                    };
                    let leaves = nx.is_leaf() && ny.is_leaf();
                    if !(leaves || one_to_one || similarity >= 0.3) {
                        continue;
                    }
                    // Two differently named declarations in one place are
                    // a replacement unless the code is mostly the same (a
                    // rename).
                    if renamed_declaration(ta, tb, x, y) && similarity < 0.5 {
                        continue;
                    }
                    // Relative positions among the free children, scaled to
                    // compare lists of different lengths symmetrically.
                    let position = (i * free_b.len()).abs_diff(j * free_a.len());
                    let rank = Rank {
                        named: Reverse(same_name(ta, tb, x, y)),
                        similarity: Reverse(scaled(similarity)),
                        neighbors: Reverse(aligned_neighbors(ta, tb, m, x, y)),
                        position,
                        ..Rank::new(x, y)
                    };
                    candidates.push((rank, x, y));
                }
            }
            accept_symmetric(candidates, m, Mapping::link);
        }
        // A token swapped for another kind (`true` → `false`, `+` → `-`)
        // when it is the only leaf left on each side.
        let leaf_a: Vec<_> = free_a
            .iter()
            .copied()
            .filter(|&c| m.a_to_b[c].is_none() && ta.nodes[c].is_leaf())
            .collect();
        let leaf_b: Vec<_> = free_b
            .iter()
            .copied()
            .filter(|&c| m.b_to_a[c].is_none() && tb.nodes[c].is_leaf())
            .collect();
        if let ([x], [y]) = (leaf_a.as_slice(), leaf_b.as_slice()) {
            m.link(*x, *y);
        }
    }
    Ok(())
}

/// Order-preserving pairs of identical subtrees (patience diff): hashes
/// unique on both sides anchor, the heaviest increasing chain of anchors is
/// kept, and the ranges between anchors are aligned the same way. Where no
/// anchor exists, hashes repeated equally often on both sides pair in order.
/// Anchor weights are symmetric and practically unique, so the reverse
/// alignment keeps the same chain.
fn patience(
    ta: &SyntaxTree,
    tb: &SyntaxTree,
    xs: &[NodeId],
    ys: &[NodeId],
    deadline: &Deadline,
) -> Result<Vec<(NodeId, NodeId)>, FallbackReason> {
    const MAX_ANCHORS: usize = 4096;
    let mut out = Vec::new();
    let mut ranges = vec![(xs, ys)];
    while let Some((xs, ys)) = ranges.pop() {
        if xs.is_empty() || ys.is_empty() {
            continue;
        }
        let mut groups: BTreeMap<u64, (Vec<usize>, Vec<usize>)> = BTreeMap::new();
        deadline.tick(xs.len() + ys.len())?;
        for (i, &x) in xs.iter().enumerate() {
            groups.entry(ta.nodes[x].hash).or_default().0.push(i);
        }
        for (j, &y) in ys.iter().enumerate() {
            groups.entry(tb.nodes[y].hash).or_default().1.push(j);
        }
        let mut anchors: Vec<(usize, usize, u64)> = groups
            .iter()
            .filter(|(_, (is, js))| is.len() == 1 && js.len() == 1)
            .map(|(&hash, (is, js))| (is[0], js[0], hash))
            .collect();
        if anchors.is_empty() || anchors.len() > MAX_ANCHORS {
            for (is, js) in groups.values() {
                if is.len() == js.len() {
                    out.extend(is.iter().zip(js).map(|(&i, &j)| (xs[i], ys[j])));
                }
            }
            continue;
        }
        anchors.sort_unstable();
        // Longest chain first, then the heavier (hash-weighted) one.
        let items: Vec<(usize, u128)> = anchors
            .iter()
            .map(|&(_, j, hash)| (j, (1u128 << 64) | u128::from(hash)))
            .collect();
        let (mut from_i, mut from_j) = (0, 0);
        for index in heaviest_chain(&items, deadline)? {
            let (i, j, _) = anchors[index];
            out.push((xs[i], ys[j]));
            ranges.push((&xs[from_i..i], &ys[from_j..j]));
            (from_i, from_j) = (i + 1, j + 1);
        }
        ranges.push((&xs[from_i..], &ys[from_j..]));
    }
    Ok(out)
}
