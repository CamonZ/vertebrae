//! Following a line range from one version of a file to another: a range
//! maps only while every line of it is unchanged and contiguous.

use git2::{DiffOptions, Patch};
use serde::{Deserialize, Serialize};

use super::AnchorError;

/// Lines `start_line..=line`, 1-based.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewLineRange {
    pub(crate) start_line: u32,
    pub(crate) line: u32,
}

impl ReviewLineRange {
    /// The bytes of the range, line endings included.
    pub(crate) fn slice(self, bytes: &[u8]) -> Result<&[u8], AnchorError> {
        if self.start_line == 0 || self.line < self.start_line {
            return Err(AnchorError::InvalidRange);
        }
        let mut lines = bytes.split_inclusive(|byte| *byte == b'\n');
        let start = lines
            .by_ref()
            .take((self.start_line - 1) as usize)
            .map(<[u8]>::len)
            .sum();
        let mut end = start;
        for _ in self.start_line..=self.line {
            end += lines.next().ok_or(AnchorError::InvalidRange)?.len();
        }
        Ok(&bytes[start..end])
    }
}

#[derive(Clone, Copy, Debug)]
struct Hunk {
    old_start: u32,
    old_lines: u32,
    new_lines: u32,
}

/// The changes from `original` to `current`, computed once to map many
/// ranges.
pub(crate) struct LineMap<'a> {
    original: &'a [u8],
    current: &'a [u8],
    hunks: Vec<Hunk>,
}

impl<'a> LineMap<'a> {
    pub(crate) fn new(original: &'a [u8], current: &'a [u8]) -> Result<Self, AnchorError> {
        let mut options = DiffOptions::new();
        options.context_lines(0).force_text(true);
        let patch = Patch::from_buffers(original, None, current, None, Some(&mut options))?;
        let hunks = (0..patch.num_hunks())
            .map(|index| {
                let (hunk, _) = patch.hunk(index)?;
                Ok(Hunk {
                    old_start: hunk.old_start(),
                    old_lines: hunk.old_lines(),
                    new_lines: hunk.new_lines(),
                })
            })
            .collect::<Result<_, git2::Error>>()?;
        Ok(Self {
            original,
            current,
            hunks,
        })
    }

    /// Where `range` of `original` sits in `current`; `None` once an edit
    /// touches it.
    pub(crate) fn map(
        &self,
        range: ReviewLineRange,
    ) -> Result<Option<ReviewLineRange>, AnchorError> {
        let anchored = range.slice(self.original)?;
        let mut offset = 0_i64;
        for hunk in &self.hunks {
            let start = hunk.old_start;
            let removed = hunk.old_lines;
            if removed == 0 {
                if start >= range.line {
                    break;
                }
                if start >= range.start_line {
                    return Ok(None);
                }
            } else {
                if start > range.line {
                    break;
                }
                if start + removed > range.start_line {
                    return Ok(None);
                }
            }
            offset += i64::from(hunk.new_lines) - i64::from(removed);
        }

        let mapped = ReviewLineRange {
            start_line: u32::try_from(i64::from(range.start_line) + offset)
                .map_err(|_| AnchorError::InvalidRange)?,
            line: u32::try_from(i64::from(range.line) + offset)
                .map_err(|_| AnchorError::InvalidRange)?,
        };
        Ok((mapped.slice(self.current).ok() == Some(anchored)).then_some(mapped))
    }
}

/// Where `range` of `original` sits in `current`.
pub(crate) fn map_range(
    original: &[u8],
    current: &[u8],
    range: ReviewLineRange,
) -> Result<Option<ReviewLineRange>, AnchorError> {
    range.slice(original)?;
    LineMap::new(original, current)?.map(range)
}

/// Lines `from..=to` (1-based, clamped to the text) with their numbers,
/// without line endings (`\n` or `\r\n`).
pub(crate) fn numbered_lines(text: &str, from: u32, to: u32) -> Vec<(u32, String)> {
    text.lines()
        .zip(1_u32..)
        .skip_while(|(_, number)| *number < from.max(1))
        .take_while(|(_, number)| *number <= to)
        .map(|(line, number)| (number, line.strip_suffix('\r').unwrap_or(line).to_owned()))
        .collect()
}

#[cfg(test)]
mod tests;
