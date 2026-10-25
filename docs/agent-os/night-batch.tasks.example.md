# Night batch — example task list
#
# One task per line. Blank lines and comments (#) are ignored. A leading "- " or "* "
# is stripped. The script refuses the whole file if any line looks like an outbound
# action (send/email/slack/webhook/tweet/publish/deploy/transfer/charge/invoice).
#
# Keep tasks bounded, read-only, and self-contained: the child agent cannot ask a
# human follow-up question at 02:30. Good tasks survey, summarize, classify, or
# propose; they never mutate production, push, spend, or contact anyone.

Survey open TODOs in the profile repo and list the five highest-leverage ones with file and line references.
Summarize the last five session logs in ~/.dsh/sessions and report which workstreams used the most tokens.
Read docs/agent-os/README.md and list every place where the automation still needs a human to approve something.
Draft three candidate additions to docs/improvements.md based on docs/harness-comparison-2026-10.md, with no file edits.
Compare scripts/usage-meter.mjs against the session log format in docs and list any field it ignores.
