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

Claude Sonnet 5.5 is available as `claude-sonnet-5-5` for Claude daemon steps
and as an explicit desktop Anthropic chat model option. It requires Claude Code
2.1.284 or later, and the chat utilization badge uses its native 1M-token window.

Claude Haiku 5.5 is available as `claude-haiku-5-5` for Claude daemon steps
and in the desktop Anthropic chat model picker. Both paths require Claude Code
2.1.293 or later. On the Anthropic API, that version also advances the `haiku`
alias to Haiku 5.5; alias resolution on other platforms can differ. Use the
explicit model ID to select this version. Haiku 5.5 has a native 1M-token
context window, reflected in the chat utilization badge. Claude Code manages
adaptive thinking and its default medium effort; Vertebrae's explicit
`reasoning_effort` setting remains Codex-only. See the
[Claude Code model configuration](https://code.claude.com/docs/en/model-config)
for provider availability and configuration.

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
For older Codex versions whose bundled catalog omits the field, Vertebrae uses
an explicit compatibility projection: known GPT-5.6 Luna/Terra/Sol models are
restricted, while other legacy catalog models retain the existing Codex
personality enum until live app-server discovery is available.
