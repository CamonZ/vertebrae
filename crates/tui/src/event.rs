//! Event handling for the TUI.
//!
//! Provides keyboard event polling and handling.

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyModifiers};
use std::time::Duration;

use crate::TuiResult;

/// Poll for keyboard events with a timeout.
///
/// Returns `Some(KeyEvent)` if a key was pressed within the timeout,
/// or `None` if no key was pressed.
pub fn poll_key(timeout: Duration) -> TuiResult<Option<KeyEvent>> {
    if event::poll(timeout)?
        && let Event::Key(key) = event::read()?
    {
        return Ok(Some(key));
    }
    Ok(None)
}

/// Check if the key event represents a quit command.
///
/// Returns `true` for 'q' key or Ctrl+C.
pub fn is_quit(key: &KeyEvent) -> bool {
    matches!(
        key,
        KeyEvent {
            code: KeyCode::Char('q'),
            modifiers: KeyModifiers::NONE,
            ..
        } | KeyEvent {
            code: KeyCode::Char('c'),
            modifiers: KeyModifiers::CONTROL,
            ..
        }
    )
}

/// Check if the key event is the Tab key.
pub fn is_tab(key: &KeyEvent) -> bool {
    matches!(
        key,
        KeyEvent {
            code: KeyCode::Tab,
            ..
        }
    )
}

/// Check if the key event is the down navigation key (j or Down arrow).
pub fn is_down(key: &KeyEvent) -> bool {
    matches!(
        key,
        KeyEvent {
            code: KeyCode::Char('j'),
            modifiers: KeyModifiers::NONE,
            ..
        } | KeyEvent {
            code: KeyCode::Down,
            ..
        }
    )
}

/// Check if the key event is the up navigation key (k or Up arrow).
pub fn is_up(key: &KeyEvent) -> bool {
    matches!(
        key,
        KeyEvent {
            code: KeyCode::Char('k'),
            modifiers: KeyModifiers::NONE,
            ..
        } | KeyEvent {
            code: KeyCode::Up,
            ..
        }
    )
}

/// Check if the key event is the Enter key.
pub fn is_enter(key: &KeyEvent) -> bool {
    matches!(
        key,
        KeyEvent {
            code: KeyCode::Enter,
            ..
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventKind;

    fn make_key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent {
            code,
            modifiers,
            kind: KeyEventKind::Press,
            state: event::KeyEventState::NONE,
        }
    }

    #[test]
    fn test_is_quit_q() {
        let key = make_key(KeyCode::Char('q'), KeyModifiers::NONE);
        assert!(is_quit(&key));
    }

    #[test]
    fn test_is_quit_ctrl_c() {
        let key = make_key(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert!(is_quit(&key));
    }

    #[test]
    fn test_is_quit_other() {
        let key = make_key(KeyCode::Char('x'), KeyModifiers::NONE);
        assert!(!is_quit(&key));
    }

    #[test]
    fn test_is_tab() {
        let key = make_key(KeyCode::Tab, KeyModifiers::NONE);
        assert!(is_tab(&key));
    }

    #[test]
    fn test_is_down_j() {
        let key = make_key(KeyCode::Char('j'), KeyModifiers::NONE);
        assert!(is_down(&key));
    }

    #[test]
    fn test_is_down_arrow() {
        let key = make_key(KeyCode::Down, KeyModifiers::NONE);
        assert!(is_down(&key));
    }

    #[test]
    fn test_is_up_k() {
        let key = make_key(KeyCode::Char('k'), KeyModifiers::NONE);
        assert!(is_up(&key));
    }

    #[test]
    fn test_is_up_arrow() {
        let key = make_key(KeyCode::Up, KeyModifiers::NONE);
        assert!(is_up(&key));
    }

    #[test]
    fn test_is_enter() {
        let key = make_key(KeyCode::Enter, KeyModifiers::NONE);
        assert!(is_enter(&key));
    }
}
