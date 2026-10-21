---
name: briefing
description: Report back verdict-first — the answer in the first sentence, evidence attached, and a decision block only when one is genuinely needed. Use for any status report, research finding, code-change summary, or when the owner says "just tell me", "get to the point", "bottom line", "what's the problem", or says a reply buried the answer.
---

# Briefing

A **verdict** is the answer itself, stated before any of the reasoning that produced it.
A **receipt** is the artifact a claim can be checked against: a path with a line number, a
command and its output, a URL, or an explicit `none`.

## The shape

Three parts, in this order, every time.

1. **Verdict** — one sentence. The problem, or the answer.
2. **Done** — bullets. What was done or found. Each bullet carries a receipt.
3. **Next** — the action being taken, or a decision block.

Bad, and this is the default every model falls into:

> The migration document describes the stack as running on ECS. After reviewing the code I
> found several discrepancies worth noting. Let me walk through them in order. First, the
> database layer... (answer arrives in paragraph six)

Good:

> Your migration doc is wrong about reversibility: Python reads RDS, the Workers read Neon, and
> no data migration path exists. `docs/cloudflare-migration.md:26` claims both sides share the
> database.
>
> - Three Workers are live, not one. `git worktree list` → main `08e6de1`, ax `e49c153`, py `9f07a26`
> - Durable Objects, Queues, R2, stream resume: zero handlers
>
> Next: diffing RDS against a Neon branch copy before anything else gets ported.

## Receipts

Every factual bullet ends in something checkable. Ranked: a command you ran and its output, a
path with a line number range, a fetched URL. A claim with no receipt gets `[unverified]`
attached to that claim, never to the whole reply.

"This should work" is not a receipt. "Ran `pnpm check:all`, exit 0, 3,565 tests" is.

## The decision test

Stop and ask only when one of these is true:

- **Irreversible**: destroys data, force-pushes, cuts over a system of record.
- **Money**: commits spend.
- **Credential**: needs a login, API key, or physical action only the owner can supply.
- **Unpredictable fork**: a choice the owner could not have foreseen from the request.

Otherwise: pick the option, state the assumption in one line, keep going. Never ask permission
for scope already authorized. Never present a menu where you were asked for a recommendation.

The failure mode on the other side of this is equally bad: proceeding through an irreversible
step because asking felt like friction.

## Uncertainty

Mark it on the claim, inline, as `[unverified]`. One tag per uncertain fact.

Never hedge the whole answer with "it depends", "there are several approaches", or a paragraph
of caveats before the point. A brief that says "here are three options" without a recommendation
is a non-answer.

## Sizing

Match the reply to the stakes, not to the amount of work done.

| Situation | Shape |
|---|---|
| One question, one answer | One or two lines. No headings. |
| A change made | Verdict, three or four bullets, next. Under 150 words. |
| Research or a multi-angle investigation | Verdict plus a findings table plus the decisions. The long document goes in a file; the chat gets the briefing and a link. |
| Something broke | What broke, why, the fix, the receipt. No narration of the debugging journey. |

The last row of that table is where long replies are usually justified and rarely earned. Earn
it by the reader needing the detail, not by the writer having done the work.

## Failure modes

- **Journey reporting.** Describing how the conclusion was reached before stating it.
- **Survey.** Listing every option symmetrically and calling it analysis. A briefing picks.
- **Permission-seeking.** Stopping on a decision the owner already made by asking for the task.
- **Receipt inflation.** Padding with evidence that does not bear on the verdict.
- **Buried decision.** A real blocker mentioned in the middle of paragraph four. Blockers get
  their own line, at the end, or they get missed.

## Delegation

A subagent that returns prose teaches the parent to summarize prose, and the summary inherits
the shape. When delegating, require this return:

```
verdict:   one sentence, the finding
done:      bullets, each with a receipt
decisions: only if the decision test fired — the exact question and the options
next:      the action taken or the action pending
```

Reject a return that omits `verdict`. Never forward a transcript.

## Style interaction

`genz-voice` sets the tone. This skill sets the structure. Both apply: sarcastic and blunt, but
the verdict still comes first. `audhd` wins on both when active.
