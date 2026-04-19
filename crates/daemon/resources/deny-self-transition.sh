#!/usr/bin/env bash
# PreToolUse hook: denies `vtb transition-to` / `vtb workflow assign` so
# step agents can't advance their own tasks. Pure bash (no jq/perl/python)
# so the script runs wherever `claude` does.

set -u

input=$(cat)

# The forbidden pattern matches the substrings:
#     vtb transition-to
#     vtb workflow assign
# anywhere in the JSON. A leading non-word-char boundary guard avoids matching
# substrings of longer identifiers (e.g. `myvtb` or `-vtb`). We also accept
# start-of-string via the alternation.
#
# Because the JSON contains the raw command text, matching against the full
# stdin catches wrapped forms that would otherwise evade a prefix check:
#     "sh -c 'vtb transition-to ...'"
#     "foo && vtb transition-to ..."
#     "env X=1 vtb transition-to ..."
if [[ "$input" =~ (^|[^[:alnum:]_-])vtb[[:space:]]+(transition-to|workflow[[:space:]]+assign)([[:space:]]|\\|\"|$) ]]; then
    cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "The vertebrae workflow engine owns step transitions. Do not call 'vtb transition-to' or 'vtb workflow assign'. Finish your work and exit -- the daemon will advance the step."
  }
}
JSON
    exit 0
fi

exit 0
