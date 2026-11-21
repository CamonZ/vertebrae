//! Comparison-level projection of semantic edits and provider call edges.

use crate::intelligence::{
    Answer, Budget, Call, CodeIntelligence, CodeSymbol, ProviderId, Resolution, Snapshot,
    SourceLocation, SymbolKey, Truncation,
};
use crate::semantic::{
    DeclarationChange, DeclarationDiff, DeclarationKind, EffectKind, LineSpan, Part,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Old,
    New,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SymbolId {
    pub path: String,
    pub scope: Vec<String>,
    pub kind: Option<DeclarationKind>,
    /// Distinguishes repeated declarations with the same scope path.
    pub occurrence: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum EditKind {
    Added,
    Removed,
    Modified,
    Renamed,
    Moved,
    SignatureChanged,
}

/// A semantic declaration and its edit spans, in the comparison's diff file.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SymbolEdit {
    pub path: String,
    pub old_path: String,
    pub index: u32,
    pub old_revision: Option<String>,
    pub new_revision: Option<String>,
    pub declaration: DeclarationDiff,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ChangedSymbol {
    pub id: SymbolId,
    pub change: EditKind,
    pub edits: Vec<SymbolEdit>,
    /// Indices into the comparison's calls, on their respective sides.
    pub effects: Vec<u32>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ComparisonCall {
    pub side: Side,
    pub call: Call,
    pub changed_caller: Option<u32>,
    /// Changed candidates. The call still contains the provider's full
    /// resolution, including unchanged candidates.
    pub changed_targets: Vec<u32>,
    pub effect: Option<EffectKind>,
    /// Recognized boundary calls made by an exact, unchanged callee.
    pub callee_effects: Vec<BoundaryEffect>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct BoundaryEffect {
    pub callee: String,
    pub site: SourceLocation,
    pub kind: EffectKind,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ChangedSymbols {
    pub symbols: Vec<ChangedSymbol>,
    pub calls: Vec<ComparisonCall>,
    pub provider: ProviderId,
    pub incomplete: bool,
}

pub struct ChangedFile<'a> {
    pub path: &'a str,
    pub old_path: &'a str,
    pub old: &'a str,
    pub new: &'a str,
    pub old_revision: Option<&'a str>,
    pub new_revision: Option<&'a str>,
    pub declarations: Vec<DeclarationDiff>,
}

type MoveKey = (DeclarationKind, String);

fn move_key(kind: Option<DeclarationKind>, text: &str, span: LineSpan) -> Option<MoveKey> {
    // Compare the whole declaration's bytes, excluding leading trivia
    // (the semantic engine supplies the heading). Reject ambiguous copies.
    let content = text
        .lines()
        .skip((span.start - 1) as usize)
        .take((span.end - span.start + 1) as usize)
        .collect::<Vec<_>>()
        .join("\n");
    Some((kind?, content.trim().to_owned()))
}

fn edit_kind(declaration: &DeclarationDiff) -> EditKind {
    match declaration.change {
        DeclarationChange::Added { .. } => EditKind::Added,
        DeclarationChange::Removed { .. } => EditKind::Removed,
        DeclarationChange::Moved { .. } => EditKind::Moved,
        DeclarationChange::Renamed { .. } => EditKind::Renamed,
        DeclarationChange::Modified
            if declaration
                .parts
                .iter()
                .any(|part| matches!(part, Part::Signature { .. })) =>
        {
            EditKind::SignatureChanged
        }
        DeclarationChange::Modified => EditKind::Modified,
    }
}

fn collect_symbols(files: Vec<ChangedFile<'_>>) -> Vec<ChangedSymbol> {
    let mut symbols = Vec::new();
    let mut removed: HashMap<MoveKey, Vec<usize>> = HashMap::new();
    let mut added: HashMap<MoveKey, Vec<usize>> = HashMap::new();
    let mut occurrences = HashMap::new();
    for file in files {
        for (index, declaration) in file.declarations.into_iter().enumerate() {
            let change = edit_kind(&declaration);
            let scope: Vec<_> = declaration
                .scope
                .iter()
                .chain(&declaration.subject)
                .map(|segment| segment.name.clone())
                .collect();
            let kind = declaration.subject.as_ref().map(|subject| subject.kind);
            let path = if change == EditKind::Removed {
                file.old_path
            } else {
                file.path
            };
            let occurrence = occurrences.entry((path, scope.clone(), kind)).or_insert(0);
            let id = SymbolId {
                path: path.to_owned(),
                scope,
                kind,
                occurrence: *occurrence,
            };
            *occurrence += 1;
            let candidate = match declaration.change {
                DeclarationChange::Added { new, head } => move_key(
                    kind,
                    file.new,
                    LineSpan {
                        start: head,
                        end: new.end,
                    },
                )
                .map(|key| (&mut added, key)),
                DeclarationChange::Removed { old, head } => move_key(
                    kind,
                    file.old,
                    LineSpan {
                        start: head,
                        end: old.end,
                    },
                )
                .map(|key| (&mut removed, key)),
                _ => None,
            };
            if let Some((index, key)) = candidate {
                index.entry(key).or_default().push(symbols.len());
            }
            symbols.push(Some(ChangedSymbol {
                id,
                change,
                edits: vec![SymbolEdit {
                    path: file.path.to_owned(),
                    old_path: file.old_path.to_owned(),
                    index: index as u32,
                    old_revision: file.old_revision.map(str::to_owned),
                    new_revision: file.new_revision.map(str::to_owned),
                    declaration,
                }],
                effects: Vec::new(),
            }));
        }
    }
    for (key, from) in removed {
        let ([from], Some([to])) = (from.as_slice(), added.get(&key).map(Vec::as_slice)) else {
            continue;
        };
        let (Some(source), Some(target)) = (&symbols[*from], &symbols[*to]) else {
            continue;
        };
        if source.id.path == target.id.path {
            continue;
        }
        if let Some(mut source) = symbols[*from].take() {
            if let Some(target) = symbols[*to].as_mut() {
                target.change = EditKind::Moved;
                target.edits.append(&mut source.edits);
            }
        }
    }
    symbols.into_iter().flatten().collect()
}

fn definition_matches(definition: &CodeSymbol, edit: &SymbolEdit, side: Side) -> bool {
    let Some(subject) = &edit.declaration.subject else {
        return false;
    };
    let (line, name) = match (side, &edit.declaration.change) {
        (Side::Old, DeclarationChange::Renamed { from, .. }) => (subject.old_line, from),
        (Side::Old, _) => (subject.old_line, &subject.name),
        (Side::New, _) => (subject.new_line, &subject.name),
    };
    definition.kind == subject.kind
        && &definition.name == name
        && definition.scope.iter().map(String::as_str).eq(edit
            .declaration
            .scope
            .iter()
            .map(|segment| segment.name.as_str()))
        && line.is_some_and(|line| definition.span.contains(line))
}

fn call_effect(call: &Call) -> Option<EffectKind> {
    matches!(call.resolution, Resolution::Unresolved)
        .then(|| crate::semantic::call_effect(&call.site.path, &call.callee))
        .flatten()
}

#[derive(Default)]
struct ChangedEndpoints {
    definitions: HashMap<SymbolKey, u32>,
    top_level: HashMap<String, u32>,
}

struct Projection<'a> {
    provider: &'a dyn CodeIntelligence,
    budget: Budget,
    deadline: Instant,
    incomplete: bool,
}

impl Projection<'_> {
    fn request<T>(
        &mut self,
        share: usize,
        query: impl FnOnce(&Budget) -> crate::intelligence::Outcome<T>,
    ) -> Vec<T> {
        let remaining = self.deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            self.incomplete = true;
            return Vec::new();
        }
        match query(&Budget {
            time: remaining / share as u32,
            ..self.budget
        }) {
            Ok(Answer {
                items, truncated, ..
            }) => {
                self.incomplete |= truncated.is_some_and(|reason| reason != Truncation::DepthLimit);
                items
            }
            Err(_) => {
                self.incomplete = true;
                Vec::new()
            }
        }
    }

    fn calls(
        &mut self,
        snapshot: &dyn Snapshot,
        side: Side,
        symbols: &[ChangedSymbol],
    ) -> Vec<ComparisonCall> {
        let provider = self.provider;
        let mut definitions = HashMap::new();
        let mut endpoints = ChangedEndpoints::default();
        let mut keys = Vec::new();
        let mut top_paths = Vec::new();
        for (index, symbol) in symbols.iter().enumerate() {
            for edit in &symbol.edits {
                let (path, revision) = match side {
                    Side::Old => (&edit.old_path, &edit.old_revision),
                    Side::New => (&edit.path, &edit.new_revision),
                };
                if revision.is_none() {
                    continue;
                }
                if edit.declaration.subject.is_none() {
                    if endpoints
                        .top_level
                        .insert(path.clone(), index as u32)
                        .is_none()
                    {
                        top_paths.push(path.clone());
                    }
                    continue;
                }
                if matches!(
                    (side, &edit.declaration.change),
                    (Side::Old, DeclarationChange::Added { .. })
                        | (Side::New, DeclarationChange::Removed { .. })
                ) {
                    continue;
                }
                let definitions = definitions.entry(path).or_insert_with(|| {
                    self.request(1, |budget| provider.definitions(snapshot, path, budget))
                });
                let mut matches = definitions
                    .iter()
                    .filter(|def| definition_matches(def, edit, side));
                if let (Some(definition), None) = (matches.next(), matches.next()) {
                    let key = definition.key();
                    if endpoints
                        .definitions
                        .insert(key.clone(), index as u32)
                        .is_none()
                    {
                        keys.push(key);
                    }
                }
            }
        }

        let mut calls = Vec::new();
        let mut result_limit = false;
        let mut seen = HashSet::new();
        let max_results = self.budget.max_results;
        let mut record = |call: Call| {
            if calls.len() == max_results {
                result_limit |= !seen.contains(&call);
                return;
            }
            if !seen.insert(call.clone()) {
                return;
            }
            let changed_caller = match &call.caller {
                Some(caller) => endpoints.definitions.get(&caller.key()),
                None => endpoints.top_level.get(&call.site.path),
            }
            .copied();
            let mut changed_targets = call
                .resolution
                .targets()
                .iter()
                .filter_map(|target| endpoints.definitions.get(&target.key()).copied())
                .collect::<Vec<_>>();
            changed_targets.sort_unstable();
            changed_targets.dedup();
            let effect = call_effect(&call);
            calls.push(ComparisonCall {
                side,
                call,
                changed_caller,
                changed_targets,
                effect,
                callee_effects: Vec::new(),
            });
        };
        // Let every changed symbol make progress even if one definition's
        // unresolved calls spend their share searching the whole snapshot.
        for (index, key) in keys.iter().enumerate() {
            let share = 2 * (keys.len() - index + top_paths.len());
            self.request(share, |budget| {
                provider.outgoing_calls(snapshot, key, budget)
            })
            .into_iter()
            .for_each(&mut record);
        }
        for (index, path) in top_paths.iter().enumerate() {
            self.request(2 * (top_paths.len() - index), |budget| {
                provider.module_calls(snapshot, path, budget)
            })
            .into_iter()
            .for_each(&mut record);
        }
        for (index, key) in keys.iter().enumerate() {
            self.request(2 * (keys.len() - index), |budget| {
                provider.incoming_calls(snapshot, key, 1, budget)
            })
            .into_iter()
            .map(|edge| edge.call)
            .for_each(&mut record);
        }
        self.incomplete |= result_limit;
        self.boundary_effects(snapshot, &mut calls);
        calls
    }
    /// Check effects in an unchanged, exact callee at the edge of the graph.
    /// Keep these terminal calls as evidence on that edge instead of adding
    /// relations between unchanged symbols to the comparison.
    fn boundary_effects(&mut self, snapshot: &dyn Snapshot, calls: &mut [ComparisonCall]) {
        let mut edges = calls
            .iter_mut()
            .filter_map(|edge| {
                let Resolution::Exact { target } = &edge.call.resolution else {
                    return None;
                };
                (edge.changed_caller.is_some() && edge.changed_targets.is_empty())
                    .then(|| (target.key(), &mut edge.callee_effects))
            })
            .collect::<Vec<_>>();
        let mut effects = HashMap::<_, Vec<_>>::new();
        let count = edges.len();
        let provider = self.provider;
        for (offset, (target, out)) in edges.drain(..).enumerate() {
            let found = effects.entry(target).or_insert_with_key(|key| {
                self.request(count - offset, |budget| {
                    provider.outgoing_calls(snapshot, key, budget)
                })
                .into_iter()
                .filter_map(|call| {
                    let kind = call_effect(&call)?;
                    Some(BoundaryEffect {
                        callee: call.callee,
                        site: call.site,
                        kind,
                    })
                })
                .collect()
            });
            out.clone_from(found);
        }
    }
}

/// A one-hop graph around changed symbols, with calls from both snapshots.
/// Effects follow exact calls through changed symbols and one unchanged callee to recognized APIs.
pub fn project(
    files: Vec<ChangedFile<'_>>,
    provider: &dyn CodeIntelligence,
    old: &dyn Snapshot,
    new: &dyn Snapshot,
    budget: &Budget,
) -> ChangedSymbols {
    let mut symbols = collect_symbols(files);
    let mut projection = Projection {
        provider,
        budget: *budget,
        deadline: Instant::now() + budget.time / 2,
        incomplete: false,
    };
    let deadline = Instant::now() + budget.time;
    let mut calls = projection.calls(new, Side::New, &symbols);
    projection.deadline = deadline;
    calls.extend(projection.calls(old, Side::Old, &symbols));
    let mut outgoing = HashMap::<_, Vec<_>>::new();
    for (index, call) in calls.iter().enumerate() {
        if let Some(caller) = call.changed_caller {
            outgoing.entry((call.side, caller)).or_default().push(index);
        }
    }
    for (index, symbol) in symbols.iter_mut().enumerate() {
        for side in [Side::Old, Side::New] {
            let mut seen = HashSet::from([index as u32]);
            let mut queue = VecDeque::from([index as u32]);
            while let Some(caller) = queue.pop_front() {
                for &edge in outgoing.get(&(side, caller)).into_iter().flatten() {
                    let call = &calls[edge];
                    if call.effect.is_some() || !call.callee_effects.is_empty() {
                        symbol.effects.push(edge as u32);
                    }
                    if matches!(call.call.resolution, Resolution::Exact { .. }) {
                        queue.extend(
                            call.changed_targets
                                .iter()
                                .copied()
                                .filter(|target| seen.insert(*target)),
                        );
                    }
                }
            }
        }
    }
    ChangedSymbols {
        symbols,
        calls,
        provider: provider.id(),
        incomplete: projection.incomplete,
    }
}
