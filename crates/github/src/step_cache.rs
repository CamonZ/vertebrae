//! Failing step names of completed check runs, by check run id. A completed
//! run never changes, so an entry stays valid until it is evicted (oldest
//! first).

use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};

const CAPACITY: usize = 512;

#[derive(Debug, Default)]
pub(crate) struct FailedStepCache {
    entries: Mutex<Entries>,
}

#[derive(Debug, Default)]
struct Entries {
    steps: HashMap<u64, Option<String>>,
    order: VecDeque<u64>,
}

impl FailedStepCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, Entries> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `Some(None)` is a run known to have no failed step.
    pub(crate) fn get(&self, run_id: u64) -> Option<Option<String>> {
        self.lock().steps.get(&run_id).cloned()
    }

    pub(crate) fn insert(&self, run_id: u64, step: Option<String>) {
        let mut guard = self.lock();
        let Entries { steps, order } = &mut *guard;
        if steps.insert(run_id, step).is_none() {
            order.push_back(run_id);
        }
        while order.len() > CAPACITY {
            if let Some(oldest) = order.pop_front() {
                steps.remove(&oldest);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hegel::generators as gs;

    /// Oldest-first insertion order with each run's answer. A re-insert of a
    /// cached run replaces its answer but keeps its place in the order.
    #[derive(Default)]
    struct Model(Vec<(u64, Option<String>)>);

    impl Model {
        fn get(&self, run_id: u64) -> Option<Option<String>> {
            self.0
                .iter()
                .find(|(id, _)| *id == run_id)
                .map(|(_, step)| step.clone())
        }

        fn insert(&mut self, run_id: u64, step: Option<String>) {
            match self.0.iter_mut().find(|(id, _)| *id == run_id) {
                Some(entry) => entry.1 = step,
                None => self.0.push((run_id, step)),
            }
            while self.0.len() > CAPACITY {
                self.0.remove(0);
            }
        }
    }

    /// Insertion order and the step map agree, entry for entry, with the
    /// model, and stay within capacity.
    fn assert_matches(cache: &FailedStepCache, model: &Model) {
        let entries = cache.lock();
        assert!(entries.order.len() <= CAPACITY);
        assert_eq!(entries.steps.len(), entries.order.len());
        let order: Vec<u64> = entries.order.iter().copied().collect();
        let expected: Vec<u64> = model.0.iter().map(|(id, _)| *id).collect();
        assert_eq!(order, expected);
        for (id, step) in &model.0 {
            assert_eq!(entries.steps.get(id), Some(step));
        }
    }

    /// Arbitrary insert/get sequences, re-inserts included, behave like a
    /// capped insertion-ordered list. A prefill near capacity makes eviction
    /// reachable with the real capacity; generated ids overlap the prefill so
    /// the oldest entries are both re-inserted and evicted.
    #[hegel::test(test_cases = 60)]
    fn cache_matches_a_capped_insertion_ordered_model(tc: hegel::TestCase) {
        let cache = FailedStepCache::default();
        let mut model = Model::default();
        let prefill = tc.draw(gs::integers::<usize>().max_value(CAPACITY + 2));
        for id in 0..prefill as u64 {
            let step = (id % 3 != 0).then(|| format!("step {id}"));
            cache.insert(id, step.clone());
            model.insert(id, step);
        }
        assert_matches(&cache, &model);

        let steps = tc.draw(gs::integers::<usize>().min_value(1).max_value(40));
        for _ in 0..steps {
            // Ids below 8 hit the oldest prefilled entries; the rest are new
            // or recently added.
            let run_id = if tc.draw(gs::booleans()) {
                tc.draw(gs::integers::<u64>().max_value(8))
            } else {
                CAPACITY as u64 - 4 + tc.draw(gs::integers::<u64>().max_value(16))
            };
            if tc.draw(gs::booleans()) {
                let step = if tc.draw(gs::booleans()) {
                    Some(tc.draw(gs::text().max_size(8)))
                } else {
                    None
                };
                tc.note(&format!("insert({run_id}, {step:?})"));
                cache.insert(run_id, step.clone());
                model.insert(run_id, step);
            } else {
                tc.note(&format!("get({run_id})"));
                // Miss, known-without-step and known step stay distinct.
                assert_eq!(cache.get(run_id), model.get(run_id));
            }
            assert_matches(&cache, &model);
        }
    }
}
