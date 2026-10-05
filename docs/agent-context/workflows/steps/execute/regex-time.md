# Regex and time helpers

Execute scripts expose bounded regular-expression helpers and timezone-aware
timestamp helpers under `vtb::regex` and `vtb::time`. These are pure local
operations; they do not add filesystem, network, or process access.

## Regular expressions

```rhai
let found = vtb::regex::is_match(task.title, #"(?i)bug|defect"#);
let groups = vtb::regex::captures("ticket-42", #"ticket-(\d+)"#);
let renamed = vtb::regex::replace_all("ticket-42", #"ticket-(\d+)"#, "issue-$1");
```

- `is_match(text, pattern)` returns a boolean.
- `captures(text, pattern)` returns an array containing the first match and
  its groups; unmatched optional groups are `()`. It returns `()` when nothing
  matches.
- `replace_all(text, pattern, replacement)` replaces all matches. Replacement
  references use Rust regex syntax such as `$1` or `${name}`.

Patterns use Rust's linear-time `regex` engine: look-around and backreferences
are unsupported. Pattern length is limited to 4 KiB, text to 64 KiB, captures
to 128 groups, and replacement output to 1 MiB. A conservative expansion bound
is checked before allocating capture-expanded replacement text. Regex compilation
is also capped at 1 MiB for the compiled program and DFA. Invalid patterns and
limit violations raise catchable `invalid` Rhai host errors.

## Timestamps

```rhai
let start = vtb::time::parse_iso8601("2026-10-05T12:30:00+02:00");
let end = vtb::time::add_millis(start, 90_000);
let elapsed = vtb::time::difference_millis(end, start);
let normalized = vtb::time::format_iso8601(end);
let is_later = end > start;
```

- `parse_iso8601(text)` accepts an extended calendar date (`YYYY-MM-DD`) or
  an extended date-time with an explicit offset, including minute precision,
  seconds and fractional seconds. Date-only values mean midnight UTC. Date-time
  values without an offset are rejected to avoid host-local timezone behavior.
- Parsed timestamps are signed Unix epoch milliseconds. Fractional precision
  below a millisecond is truncated.
- `format_iso8601(milliseconds)` emits UTC with exactly millisecond precision
  (for example, `2026-10-05T10:31:30.000Z`).
- `add_millis(timestamp, duration)`, `subtract_millis(timestamp, duration)`,
  and `difference_millis(later, earlier)` return signed milliseconds and fail
  on integer overflow. Compare parsed timestamp integers with Rhai's normal
  comparison operators.

Timestamp input is limited to 128 bytes. Unsupported date forms, invalid
calendar values, ambiguous local date-times, and out-of-range arithmetic raise
catchable `invalid` Rhai host errors.

This is a deliberately defined ISO 8601 subset, not a parser for every ISO
8601 representation (for example, week dates and basic dates without hyphens
are not accepted).

## Related

[Settings](settings.md) · [Context bindings and output](input-output.md) ·
[Limits and cancellation](limits.md)
