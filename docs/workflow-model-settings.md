# Workflow model settings contract

Workflow steps carry optional provider-neutral execution settings through
`AgentConfig` and `RequestConfig`:

- `speed_tier` is a typed `default`/`fast` preference. Adapters map it to
  their native serving controls.
- `personality` is an opaque, normalized provider style identifier. The
  Codex adapter validates and forwards `none`, `friendly`, and `pragmatic`;
  the Claude adapter maps compatible values to `outputStyle`.
- `verbosity` is a typed `low`/`medium`/`high` output-detail preference. It
  remains independent from reasoning effort, speed, and personality.

The effective value for each setting is resolved in this order:

1. an explicit `RequestConfig` value supplied by the caller;
2. the persisted step `AgentConfig` value;
3. the provider default when both are absent.

Provider validation happens before a runtime is started. Unsupported values
produce an actionable request error; omitted values are preserved as omitted
so existing workflow definitions retain their behavior.

Codex currently exposes `model_verbosity` as an app-server configuration
setting rather than a `thread/start` or `turn/start` field. Since Vertebrae
creates one app-server process per runtime, a selected verbosity is delivered
as a process-local `-c model_verbosity=<low|medium|high>` override. This keeps
concurrent task runs isolated and avoids changing the user's shared Codex
configuration. The eventual Responses API request remains conceptually
separate: its corresponding output control is `text.verbosity`.

Codex personality is sent through the app-server `personality` request field,
but its availability is model-specific and must come from authoritative
capability discovery. A missing capability is not treated as support; the
surface must represent that state explicitly or apply a documented fallback.
