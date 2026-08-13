# durable:agent

> An agent **harness** as a Meteor package. `Meteor.agent` is a
> `durable:workflow` whose steps are LLM turns and tool calls — with live
> steering, interrupts, context compaction, run forking, budgets, and a ladder
> of human approval gates. Every one of those features is a journal entry, so
> every one of them survives a server crash.

Part of the **[meteor-durable](../../..)** exploration of new Meteor primitives.
Experimental / proof-of-concept.

```js
import { pay } from '/server/ledger';                  // a keyring method (3-of-5 co-sign)

export const Clerk = Meteor.agent({
  name: 'clerk',
  model: 'anthropic:claude-sonnet-5',                  // or any registered/custom model
  instructions: [
    'You are the accounts clerk.',
    ({ key }) => `This conversation is about expense ${key}.`,
  ],
  tools: [lookup, email, pay],                         // auto · ask · cosign (inferred)
  budget: { turns: 20, steps: 8, spend: '$1.00' },
  on: { afterTool: ({ tool, ok }) => console.log(tool, ok) },
});

await Clerk(expenseId).say(expenseId);                 // start a durable conversation
```

Client, reactively (Blaze/React/whatever — it's just Minimongo):

```js
const Clerk = Meteor.agent({ name: 'clerk' });
Clerk(key).messages();   // the live transcript
Clerk(key).status();     // idle | thinking | working | awaiting-approval | compacting | done…
Clerk(key).say('actually, cap it at $200');            // steering, mid-task
```

## Why

Every serious agent harness — [pi](https://github.com/badlogic/pi-mono), Claude
Code, and friends — ends up building the same machinery around the model loop:

| Harnesses build… | Meteor already had it |
|---|---|
| A session file (append-only JSONL, tree-structured for branching) | The workflow **journal** — one Mongo doc per run, already append-only, already replayable |
| A steering queue (type while it works; inject at safe points) | The **signal mailbox** — `drain('say')` between steps |
| ESC to interrupt, without losing queued input | An `interrupt` signal; undrained messages stay queued |
| `/compact` when context overflows | A **journaled step** whose recorded summary replays byte-identically |
| `/fork` to branch a session | `workflow.fork` — copy a journal prefix, replay, diverge |
| A transcript UI | `Meteor.subscribe` to the run doc; the journal *is* the chat |
| Permission prompts before dangerous tools | A gate ladder that tops out at **threshold cryptography**, not a y/n prompt |
| Provider layer + cost metering | A model registry; per-turn usage journaled; `budget.spend` enforced |
| Crash = lost session | Crash = **resume**: replay the journal, park where you parked |

The thesis: an agent harness is a durable workflow + a reactive transcript + a
permissioned toolbelt. Meteor ships two of the three; `durable:workflow`
supplies the rest.

## The transcript is the journal

There is no separate chat state. `think` steps, tool calls, approvals,
steering, interrupts, and compactions are all journal entries; `messages()`
renders them, replay re-executes them, and forks copy them. One source of
truth, three uses.

Compaction changes what the **model** sees, never what the journal keeps — the
full history stays in the run doc and the UI still shows everything (compaction
appears as a `🗜` note).

## Steering, follow-ups, interrupts

```js
Clerk(key).say('use the corporate card');               // steering: injected at the
                                                        // next safe point mid-task
Clerk(key).say('and file the report', { followUp: true }); // held until the agent yields
Clerk(key).interrupt();                                 // soft: finish nothing else,
                                                        // yield the turn, park
Clerk(key).stop();                                      // hard: end the run (also
                                                        // auto-denies a pending ask-gate)
```

The loop reads its mailbox between steps (`drain`), like a harness pumping its
input queue between tool calls. Messages that arrive while the agent is parked
just wait — nothing is ever dropped, including across restarts.

## The gate ladder

A tool's *type* carries its gate:

- **`auto`** — plain `Meteor.method` callables and descriptors: just run.
- **`ask`** — descriptor with `gate: 'ask'`: the run durably parks
  (`awaiting-approval`, `pendingApproval` on the run doc) until one human calls
  `approve()` / `deny(reason)`. Approval timeout counts as a deny — and the
  timeout is journaled, so even "denied by silence" replays.
- **`cosign`** — a keyring method: parks for a t-of-n threshold co-sign
  (FROST-ed25519 via `durable:keyring`). The agent proposes; a quorum of
  humans disposes.

The verdict — who approved, when, or why denied — is a journal entry, i.e.
part of the permanent transcript.

## Forking

```js
const branch = await Clerk(key).fork({
  before: 'think#1.1',                       // or { at: journalIndex }
  say: 'Actually, reject this — duplicate receipt.',   // seeded steering
});
```

The fork copies the journal prefix, **replays** it (recorded steps return
their results — no tool re-fires, no double emails, no second payment), then
runs live from the cut. The seeded message is drained at the first live safe
point, so the branch diverges exactly where you cut it. Works on finished runs:
branch history, not just live state.

Fork keys append `~<id>` (reserved suffix). Instructions compose against the
**root** key — a branch is about the same subject as its parent — which is what
keeps the replayed prefix byte-identical. `runKey` is available if instructions
want the branch identity.

## Models

```js
Meteor.agent.model('triage', mockModel(script, { pricing: { input: 3, output: 15 } }));

model: 'triage'                        // registry name, resolved at run time
model: 'anthropic:claude-sonnet-5'     // built-in provider (settings/env API key)
model: { complete({ messages, tools }) { … } }   // bring your own
```

`complete` returns `{ content, toolCalls, usage }`. Usage is journaled per
turn; `usage()` gives reactive totals and `budget.spend` is enforced against
the model's pricing before each think. `mockModel(script)` — a deterministic
scripted model — makes agents testable with no API key: write the script as a
pure function of the message history and replay consistency is automatic.

## Determinism, guarded

Replay only works if the reconstructed prompt is the prompt that produced the
recorded completion. Every `think` journals a hash of its prompt and re-checks
it on replay (`verifyReplay`); drift fails loudly with `agent-drift` instead of
silently continuing with mismatched context. This guard has caught real bugs in
this repo — including a fork whose per-key instructions diverged the system
prompt — which is exactly the failure class it exists for.

## Definition reference

```js
Meteor.agent({
  name, model,                          // required
  instructions,                         // string | fn | array (concatenated, AGENTS.md-style)
  tools: [methodCallable, keyringCallable, agentHandle, { name, invoke, schema, gate, description }],
  as: 'username',                       // userId the agent's tools run as
  budget: { turns: 20, steps: 8, idle: '1 h', approval: '30 m', spend: '$1.00' },
  context: { window: 200000, compactAt: 0.8, keep: 6 },   // auto-compaction
  memory: Brain,                        // durable:memory handle (or { handle, scope }):
                                        // injects remember/recall, compaction distills
                                        // into it, and yields auto-checkpoint
  compact: (head, model) => summary,    // custom compactor (default: ask the model)
  approve: ({ userId }) => bool,        // who may approve ask-gates (default: any user)
  maxResultChars: 8000,                 // tool results truncated past this
  on: { beforeThink, afterThink, beforeTool, afterTool, onEnd },  // hooks;
                                        // beforeTool may veto: return false | { deny, reason }
});
```

Handle (server unless noted):

| Call | Description |
|---|---|
| `Agent(key).say(text, { followUp })` | Start or continue; steering if mid-run. *(both)* |
| `Agent(key).interrupt({ hard })` / `.stop()` | Yield the turn / end the run. *(both)* |
| `Agent(key).compact()` | Manual compaction at the next safe point. *(both)* |
| `Agent(key).approve()` / `.deny(reason)` | Resolve a pending ask-gate. *(both)* |
| `Agent(key).fork({ at, before, say, key })` | Branch the run; returns the new key. *(both)* |
| `Agent(key).messages()` / `.status()` / `.usage()` / `.pending()` / `.watch()` | Reactive on the client. |
| `Agent.runs(selector)` | All runs, with `forkedFrom` lineage. *(both)* |
| `await Agent.ask(text)` | Headless one-shot (fresh run, returns the yield). Also how agents compose: pass one agent as another's tool. |

## Status & limitations

- One pending ask-approval at a time (tool calls execute sequentially).
- Steering messages don't count against `budget.turns` (they're mid-turn
  guidance, not turns).
- The Anthropic provider is wired but this repo's demo runs on `mockModel` —
  bring an API key to go live.
- Everything `durable:workflow` says about journal determinism applies here.

## Prior art

[pi](https://github.com/badlogic/pi-mono) (steering/follow-up delivery,
session-as-tree, compaction-keeps-history), Claude Code (permission gates,
compaction), Temporal/Restate (journaled determinism). The point of this
package is how little is left once Meteor's primitives do the heavy lifting.

## Family

`durable:workflow` · `durable:entity` · `durable:keyring` · `durable:lens` ·
`durable:mcp` · `durable:agent` · `durable:memory`

## License

MIT (proof-of-concept; use at your own risk)
