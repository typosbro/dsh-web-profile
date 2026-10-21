# Example AGENTS.md for a repository that wants the stop gate to bite.

## Output contract

Every reply opens with the verdict: the problem, or the answer, in one sentence,
before any context. Then what was done, with receipts (path:line, command and
output, URL). Then what happens next.

Stop and ask only for an irreversible action, money, a credential only the owner
can supply, or a fork the request could not have predicted. Otherwise pick the
option, state the assumption in one line, continue.

Uncertainty attaches to a claim, never to a whole answer: mark it inline as
[unverified]. Never hedge an entire reply.

## Verification

A turn does not end on "looks done". If this repository exposes a check, run it
and paste the result. The harness stop gate enforces this: a failing
`scripts/agent-gate.sh`, `pnpm gate`, or `pnpm gate:fast` blocks the end of the
turn, twice at most, then it stands down so a pre-existing breakage cannot trap
the session.

Never claim a command, test, or benchmark passed unless its output is in the
transcript.
