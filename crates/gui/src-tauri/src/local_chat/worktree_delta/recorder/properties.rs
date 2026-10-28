//! Property tests of the window bookkeeping: random operation sequences are
//! applied to `Windows` and to a plain reference model, which must agree after
//! every step.

use std::collections::HashSet;

use hegel::generators as gs;
use hegel::TestCase;

use super::{Boundary, Windows};

#[derive(Debug, Clone, Copy)]
enum Op {
    Start(u8, Boundary),
    Finish(u8, Boundary),
    Child(Option<u8>),
    EndTurn,
}

fn id(n: u8) -> String {
    format!("t{n}")
}

/// What `Windows` is specified to do, kept as naively as possible.
#[derive(Default)]
struct Model {
    open: Vec<(String, Boundary)>,
    finished: HashSet<String>,
}

impl Model {
    fn apply(&mut self, windows: &mut Windows, op: Op) {
        match op {
            Op::Start(n, boundary) => {
                let got = windows.start(&id(n), boundary);
                let repeated =
                    self.finished.contains(&id(n)) || self.open.iter().any(|(i, _)| *i == id(n));
                if repeated {
                    assert_eq!(got, None, "a repeated start must be ignored");
                } else {
                    self.open.push((id(n), boundary));
                    assert_eq!(got, Some(self.open.len() == 1));
                }
            }
            Op::Finish(n, boundary) => {
                let got = windows.finish(&id(n), boundary);
                let position = self
                    .open
                    .iter()
                    .position(|(i, b)| *i == id(n) && *b == boundary);
                if let Some(position) = position {
                    self.open.remove(position);
                    self.finished.insert(id(n));
                    assert_eq!(got.map(|closed| closed.tool_id), Some(id(n)));
                } else {
                    assert!(got.is_none(), "only the opening boundary closes a window");
                }
            }
            Op::Child(parent) => windows.child(parent.map(id).as_deref()),
            Op::EndTurn => {
                let dropped = windows.end_turn();
                assert_eq!(dropped.len(), self.open.len());
                self.open.clear();
                self.finished.clear();
            }
        }
    }

    fn check(&self, windows: &Windows) {
        let open: Vec<_> = windows.open.iter().map(|w| w.tool_id.clone()).collect();
        let expected: Vec<_> = self.open.iter().map(|(i, _)| i.clone()).collect();
        assert_eq!(open, expected, "open windows diverge from the model");
        if windows.open.len() > 1 {
            assert!(
                windows.open.iter().all(|w| w.overlapping),
                "concurrent windows must all be marked overlapping"
            );
        }
        assert!(
            windows
                .open
                .iter()
                .all(|w| !windows.finished.contains(&w.tool_id)),
            "a finished tool must not be open"
        );
    }
}

fn draw_op(tc: &TestCase) -> Op {
    let tool = tc.draw(gs::integers::<u8>().max_value(2));
    let boundary = if tc.draw(gs::booleans()) {
        Boundary::ToolCall
    } else {
        Boundary::FileChange
    };
    match tc.draw(gs::integers::<u8>().max_value(3)) {
        0 => Op::Start(tool, boundary),
        1 => Op::Finish(tool, boundary),
        2 => Op::Child(tc.draw(gs::booleans()).then_some(tool)),
        _ => Op::EndTurn,
    }
}

#[hegel::test]
fn windows_agree_with_the_model_under_any_operation_sequence(tc: TestCase) {
    let steps = tc.draw(gs::integers::<usize>().max_value(30));
    let mut windows = Windows::default();
    let mut model = Model::default();
    for _ in 0..steps {
        let op = draw_op(&tc);
        tc.note(&format!("{op:?}"));
        model.apply(&mut windows, op);
        model.check(&windows);
    }
}
