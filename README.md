# cache-ttl

> An opencode plugin that upgrades Anthropic's prompt cache from a 5-minute TTL to 1 hour by
> stamping `ttl` onto the `cache_control` markers opencode already emits.

**~120 lines. Zero dependencies. Pure JS.**

---

## TL;DR

Anthropic's prompt cache expires after **5 minutes** of inactivity. Any pause longer than that —
a coffee break, a subagent call, a code review — throws away the cached prefix. The next turn
re-writes your entire conversation history at **1.25× input price**.

This plugin extends that window to **1 hour**. Measured on a 104k-token prefix with a 15-minute
gap: **92% cheaper**.

```
BEFORE                                AFTER
turn 1  write 104,743  read       0   turn 1  write 104,743  read       0
        ⏱  15 min gap                         ⏱  15 min gap
turn 2  write 104,754  read       0   turn 2  write      14  read 104,743
        ↑ full re-warm, $0.262                ↑ cache alive,  $0.021
```

---

## The Problem

LLMs are stateless. Every turn re-sends the whole conversation: `tools → system → messages`.
Prompt caching doesn't avoid that re-send — it makes it cheap (`0.1×` instead of `1.0×`). But the
cache entry only survives **5 minutes** past its last read.

We profiled a real agent session (opencode + Claude Opus 4.8, 55 assistant turns over 25 minutes):

| Metric | Value |
| --- | --- |
| Total cache reads | 9,546,993 tokens |
| Total cache writes | 382,183 tokens |
| Cache hit rate | 96.1% |
| **Cost** | **$8.75** |

96% hit rate looks great — until you notice **where the writes came from**:

| Write event | Tokens | Cause |
| --- | --- | --- |
| Initial cold boot | 116,412 | unavoidable |
| **Re-warm after a 7.9-min gap** | **162,474** | **TTL expiry** |
| 53 incremental deltas | ~761 (median) | normal |

One 8-minute pause cost **$1.01**. Later, a 3.5-hour gap on the same session cost **$1.34**.

It gets worse with subagents. When an agent calls another agent and waits, the parent session is
*busy*, not idle — nothing can ping it, and its cache dies while it waits:

```
20:22:56  write   4,731  read 123,713  | task     ← dispatches subagent
20:34:18  write  98,006  read  35,330  |          ← returns 11.4 min later: cache partially dead

20:58:26  write   7,203  read 138,475  | task     ← dispatches subagent
21:05:18  write 150,372  read       0  |          ← returns 6.9 min later: cache TOTALLY dead
```

**$2.39 wasted in a single session**, purely on re-warms caused by waiting.

---

## Why You Can't Just Configure It

Anthropic's API supports `"cache_control": {"type": "ephemeral", "ttl": "1h"}`. opencode's config
looks like it should let you set that. It doesn't — and it fails in two different ways.

### Attempt 1: provider-level options → silently ignored

```jsonc
"provider": { "anthropic": { "options": { "cacheControl": { "type": "ephemeral", "ttl": "1h" } } } }
```

No error. No effect. `provider.<id>.options` is the **SDK client construction bag** — it gets
spread into `createAnthropic({apiKey, baseURL, ...})`, which drops unknown keys silently. It never
reaches the request.

Proven with the `chat.params` hook, which receives the exact bag that becomes `providerOptions`:

```json
{ "temCacheControl": false, "chavesDoBag": ["reasoningEffort", "thinking", "effort"] }
```

`ProviderTransform.options()` builds `result = {}` from scratch and reads exactly one key
(`setCacheKey`) from the provider bag. Everything else is discarded.

### Attempt 2: model-level options → HTTP 400

```jsonc
"provider": { "anthropic": { "models": { "claude-opus-4-8": {
  "options": { "cacheControl": { "type": "ephemeral", "ttl": "1h" } } } } } }
```

This one *does* reach the request — and the API rejects it:

```
Top-level cache_control has ttl='1h' but the target block already has cache_control
with ttl='5m'. When both are specified on the same block, they must have matching TTLs.
```

Because opencode **already** places inline markers, without a `ttl` (which means 5m). Captured
from the real request body:

```
$.cache_control                          ttl=1h    ← ours, top-level
$.system[1].cache_control                no ttl    ← conflict
$.messages[0].content[1].cache_control   no ttl    ← conflict
```

---

## The Solution

The API's error message told us what to do: *"they must have matching TTLs."*

So don't add a top-level marker. **Stamp `ttl` onto the markers that are already there.** No
conflict by construction, and opencode keeps full control over *where* to cache — we only extend
*how long*.

There's no config knob and no plugin hook that sees the final request body, so the only insertion
point is `globalThis.fetch`:

```js
const wrappedFetch = async (input, init) => {
  try {
    if (/anthropic/i.test(url) && typeof init?.body === 'string') {
      const parsed = JSON.parse(init.body)
      stamp(parsed, cfg.ttl)                                   // walk, set ttl on every cache_control
      return originalFetch(input, { ...init, body: JSON.stringify(parsed) })
    }
  } catch { /* our bug → request passes through untouched */ }
  return originalFetch(input, init)
}
```

This is the same technique `opencode-claude-auth` uses to inject its billing header, so it's an
accepted pattern in this ecosystem — but it is the most invasive tool in the box, and it earns
three non-negotiable guards (see **Internals**).

---

## The Numbers

Cache pricing, as multiples of the base input price:

| Operation | Multiplier |
| --- | --- |
| Cache **read** | `0.1×` |
| Cache **write**, 5m TTL | `1.25×` |
| Cache **write**, 1h TTL | `2.0×` |

So a 1-hour TTL makes every write **60% more expensive** — and eliminates re-warms entirely for
any gap under an hour. The trade is worth it whenever a session gets resumed, which is the norm
for both interactive work and agent pipelines.

Measured on our verification run (104,743-token prefix, Sonnet 5, 15-minute gap):

| | Re-warm (5m TTL) | Read (1h TTL) | Saved |
| --- | --- | --- | --- |
| Tokens | 104,743 write | 104,743 read | — |
| Cost | $0.262 | $0.021 | **92%** |

Extrapolated to the gaps we actually measured in production (200k prefix, Opus 4.8):

| Real event | Before | After |
| --- | --- | --- |
| 6.9-min subagent wait (150k tokens) | $0.94 | **$0.08** |
| 3.5-hour gap (215k tokens) | $1.34 | **$0.13**¹ |
| Total re-warms in one session | $2.39 | **~$0.19** |

¹ *Gaps beyond 1 hour still expire. Pair this with a keepalive — see `session-keepalive`.*

---

## Install

```bash
npm install opencode-cache-ttl
```

```jsonc
// opencode.json
{ "plugin": [["opencode-cache-ttl", { "ttl": "1h" }]] }
```

Or vendor the single file into your project and register it by path. Restart the opencode server
afterwards — config is cached.

---

## Configuration

Register **explicitly** with the tuple form. The file must live **outside** `.opencode/plugins/`
(see *Plugin registration* under Caveats):

```jsonc
{
  "plugin": [
    ["./.opencode/custom/plugin/cache-ttl/cache-ttl.js", {
      "ttl": "1h",
      "debug": false
    }]
  ]
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Master switch. When `false`, `fetch` is never wrapped. |
| `ttl` | `"5m"` \| `"1h"` | `"1h"` | TTL to stamp. Anything else disables the plugin with a warning — the API accepts only these two. |
| `debug` | `boolean` | `false` | Log one line per modified request to **stderr**. Never stdout: that corrupts the TUI protocol. |

With `debug: true`:

```
[cache-ttl] active — stamping ttl='1h' on Anthropic cache_control markers
[cache-ttl] {"model":"claude-opus-4-8","markers":2,"stamped":2,"ttl":"1h"}
```

---

## Internals

### The three guards

Wrapping global `fetch` means every HTTP request in the process flows through your code. Three
rules make that safe:

1. **Idempotent** — a `__cacheTtlWrapped` flag prevents stacking wrappers when the plugin reloads.
2. **Narrow scope** — only URLs matching `/anthropic/i` with a `string` body that parses as JSON.
3. **Best-effort** — the entire transform sits in a `try/catch`. Any failure on our side passes
   the request through **completely untouched**. This plugin can never be the reason a turn breaks.

Plus: the transform builds a **new** `init` object rather than mutating the caller's.

### What it does not do

It never **creates** cache markers. It only stamps a `ttl` on markers opencode already decided to
place. Cache *strategy* stays where it belongs; this plugin only changes cache *lifetime*.

### What actually invalidates the cache

Worth knowing, because it is easy to blame the wrong thing. The cache lives on **Anthropic's**
infrastructure, keyed by a hash of the rendered prefix (`tools → system → messages`). Your local
process is irrelevant to it:

| Event | Cache |
| --- | --- |
| Restarting your opencode server | **survives** |
| A gap longer than the TTL | expires (that is the whole point of this plugin) |
| **Any byte change in the prefix** — config, plugin set, model, system prompt | **invalidated** |

Measured evidence for the last row, from a session where config was being edited between restarts:

```
09:06:59  write     266   read 146,835   ← cache alive
09:07:23  write 132,647   read       0   ← COLD, after a 24-SECOND gap
```

No TTL expires in 24 seconds. The prefix changed. Conversely, the first turn of a brand-new session
right after a restart read 35,693 already-cached tokens — the entry had outlived the process.

Practical consequence: while you are tuning config, expect cold starts on every restart and do not
read them as this plugin failing. Once the config settles, restarts stop costing anything.

### Wrapper ordering

**Load order determines nesting.** The plugin that wraps `fetch` **last** ends up **outermost** and
sees the request first. If you add a diagnostic plugin to audit the final body, it must load
*before* the transformer to sit inside it — otherwise it reads the body pre-transform and you'll
think nothing happened. (We lost a cycle to exactly this.)

---

## Caveats

- **Writes cost 2.0× instead of 1.25×.** Only worth it if sessions get resumed. For strictly
  one-shot, never-resumed sessions, `ttl: "5m"` is cheaper.
- **Plugin registration.** This file lives in `.opencode/custom/plugin/cache-ttl/`, *not* `.opencode/plugins/`.
  Files in `{plugin,plugins}/` are auto-discovered and registered as bare strings — **without
  options**. Since auto-discovery merges *after* config files, and dedup keeps the *last*
  occurrence, a file in both places has its options silently discarded.
- **Anthropic only.** The URL filter and the `cache_control` shape are Anthropic-specific.
- **Works in one-shot processes.** Unlike timer-based plugins, `fetch` wrapping acts *during* the
  request — so it applies to `opencode run` (detached, single-turn) too, not just long-lived servers.

---

## Verification

The cache TTL isn't visible in any response field. The only conclusive test is temporal:

1. Send a prompt in a fresh session (prefix must exceed the model's cacheable minimum — 1024
   tokens for most Claude models, 4096 for Haiku)
2. **Wait 7+ minutes** (past the old 5m TTL, well under 1h)
3. Send a second prompt to the same session
4. Read the usage:

```bash
curl -s "http://localhost:4096/session/$SID/message" | python3 -c "
import json,sys,datetime
for m in json.load(sys.stdin):
    i = m.get('info', {}); tk = i.get('tokens') or {}; c = tk.get('cache', {})
    if i.get('role') != 'assistant': continue
    h = datetime.datetime.fromtimestamp(i['time']['created']/1000).strftime('%H:%M:%S')
    print(f\"{h} | write {c.get('write',0):>8,} | read {c.get('read',0):>9,}\")"
```

| Second turn shows | Verdict |
| --- | --- |
| `read > 0` | 1h TTL is live ✅ |
| `read = 0`, large `write` | Still on 5m — the stamp isn't reaching the request |

---

## Credits

Written by **Henrique Van Klaveren**, from a measured investigation into opencode's prompt-cache
behaviour. Every number in this README came from a real session — nothing is estimated.

## License

MIT — see [`LICENSE`](./LICENSE). Use it however you like.
