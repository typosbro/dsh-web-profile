# Models: how this profile gets one

The profile ships no credentials and no default provider beyond what the DSH base ships. That is
intentional: a profile that silently routes to someone else's account is not replicable.

## Option A — native DeepSeek route

```bash
printf 'DEEPSEEK_API_KEY=sk-...\n' >> ~/.dsh/.env
```

The base profile mounts `llm-deepseek` with `apiKeyEnv: DEEPSEEK_API_KEY`; the default model is
`deepseek-official/deepseek-flash`. Nothing else to configure.

## Option B — any OpenAI-compatible gateway

Append the block in `examples/providers.cordis.patch.yml` to `profiles/web/cordis.patch.yml`,
point `baseURL` at the gateway, set `apiKeyEnv` to the env var that holds the key, and list the
models you actually want. Then pick one in the composer, or pin it with `agent-default-model`.

Field notes that cost time if you learn them the hard way:

- `models` replaces the route's catalog wholesale; a model not listed is not selectable.
- `reasoningEfforts` maps a selector level to the value sent on the wire. `off: null` means "send
  nothing"; `false` declares a model with no thinking levels at all.
- `contextWindow` is the number the harness budgets against. Guessing high causes upstream
  context errors; guessing low wastes capacity.
- `headers` are static per route. A gateway that wants a session or tenant header gets it there.

## Option C — subscription gateways

Some gateways front a subscription rather than an API key (OpenCode Go, Command Code, and
similar). They are ordinary OpenAI-compatible routes with two quirks worth knowing:

- They may require a session header on every request; put it in `headers`.
- Model ids are gateway-specific and often carry the vendor prefix (`deepseek/deepseek-v4.1-flash`,
  `xiaomi/mimo-v2.6-flash`).

Two platform facts, verified in October 2026:

- OpenCode's pay-as-you-go free models are server-gated to the official OpenCode client: any
  other caller gets `403 FreeTierError`, with or without a valid key. The same three free models
  are included in the Go subscription and work from third-party clients that send
  `x-opencode-session`.
- A raw gateway key can list models and still fail completions (no plan, no credits, expired
  key). A 200 on `/models` is not a credential test; send one real completion.

## Choosing a default

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: example
    model: example-chat
    reasoningEffort: max
```

`agent-default-model` reads only this row's config at runtime. A same-named key in a settings
file is inert.

## Cost and context

- Reasoning effort is the first knob: `off` for mechanical edits, `high`/`max` for design and
  debugging.
- A long session costs more than a fresh one with a good handoff. Compaction preserves the gist,
  not the details; put durable rules in `AGENTS.md`, not in the summary.
- If a model route exposes a context window larger than the real one, the first symptom is an
  upstream 400 mid-task. Set `contextWindow` from the provider's documentation, not from hope.
