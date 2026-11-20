# Known-API tables

One table per ecosystem; a language's registry entry lists the tables it
uses, most specific first. Each row is `pattern kind`:

- a pattern is a name split into segments by `::` (a path) or `.` (a
  member), matched against a call's (or reference's or annotation's) path
  or receiver plus name; separators must match too, so `**::env::*` (a
  module path) does not match the field access `job.env.get`; `*` matches
  one segment and a leading `**::` or `**.` any number of leading
  segments, none included, joined by that separator;
- a receiver that is not a plain name (`open(path).write`) is one segment
  that only `*` or `**` match;
- a kind is an effect (`filesystem`, `network`, `process`, `database`,
  `ipc_command`, `event`, `env`, `ui`), a concurrency primitive (`spawn`,
  `lock`) or `ignore`: a trivial call (`map`, `clone`, `len`) that is not
  reported. Ignore tables come last.

The first matching row wins. Lines starting with `#` are comments.
