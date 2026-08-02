/**
 * CacheTtl Plugin — opencode
 * ---------------------------------------------------------------------------
 * Upgrades Anthropic's prompt cache from a 5-minute TTL to 1 hour by stamping `ttl`
 * onto the `cache_control` markers opencode already emits.
 *
 * THE PROBLEM (measured, 2026-07-29/30):
 * Anthropic's prompt cache expires after 5 minutes of inactivity. On an agent pipeline —
 * and in interactive sessions — that is expensive: every resume re-writes the ENTIRE
 * history at 1.25x input price:
 *   · 6.9 min gap (waiting on a subagent via `task`) → 150,372 token re-warm
 *   · 3.5 h gap                                      → 214,936 tokens = US$ 1.34 (Opus 4.8)
 *   · a single session burned US$ 2.39 on wait-induced re-warms alone
 * With a 1-hour TTL the vast majority of gaps (10-40 min pipeline steps, subagent waits)
 * become cache READS (0.1x) instead of WRITES (2.0x).
 *
 * WHY VIA `fetch` AND NOT VIA CONFIG (the investigation that led here):
 * 1. `provider.anthropic.options.cacheControl` → does NOT reach the request. Proven with the
 *    `chat.params` hook: `optionKeys: ["reasoningEffort","thinking","effort"]`, no cacheControl.
 *    (That level's declared fields are apiKey/baseURL/timeout — it is CLIENT construction config.)
 * 2. `provider.anthropic.models.<id>.options.cacheControl` → DOES reach the request (becomes a
 *    top-level `cache_control` in the body), but the API rejects it with a 400:
 *      "Top-level cache_control has ttl='1h' but the target block already has
 *       cache_control with ttl='5m'. When both are specified on the same block,
 *       they must have matching TTLs."
 *    Because opencode ALREADY places inline markers (no ttl = 5m). Captured body map:
 *      $.cache_control                        ttl=1h   (ours, top-level)
 *      $.system[1].cache_control              no ttl   ← conflict
 *      $.messages[0].content[1].cache_control no ttl   ← conflict
 * 3. THEREFORE: do not ADD a top-level marker — STAMP the existing ones. No config hook and no
 *    plugin hook can see the final request body; `fetch` is the only insertion point.
 *
 * WHAT THIS PLUGIN DOES: wraps `globalThis.fetch`; on Anthropic requests it adds `ttl` to EVERY
 * `cache_control` in the body (including a top-level one, if present). No conflict, because they
 * all end up with the SAME ttl — which is literally what the API error asked for.
 * It NEVER creates new markers: it only extends the lifetime of the ones opencode chose to place.
 *
 * VERIFIED (2026-07-30, 104k-token prefix, Sonnet 5):
 *     10:00:54  turn 1 → write 104,743  read       0
 *     10:16:00  turn 2 → write      14  read 104,743   ← 15 min gap: CACHE ALIVE
 *
 * ⚠️ COST: a 1h cache write costs 2.0x input (vs 1.25x for the 5m one). Only worth it when the
 * session gets resumed — which is the rule on a pipeline and in interactive work. Full analysis
 * and figures in README.md.
 *
 * ⚠️ INVASIVE TECHNIQUE (wrapping global `fetch`) — the same one `opencode-claude-auth` uses to
 * inject its billing header, so it is an accepted pattern here. Three mandatory guards:
 *   1. IDEMPOTENT     — the `__cacheTtlWrapped` flag prevents stacking wrappers on reload
 *   2. NARROW SCOPE   — only URLs matching `anthropic` with a string body that parses as JSON
 *   3. BEST-EFFORT    — any failure on our side lets the request through UNTOUCHED
 *
 * Register EXPLICITLY in opencode.json (outside `.opencode/plugins/`, which is auto-discovered
 * and receives no options — see the dedup pitfall in README.md):
 *     "plugin": [["./.opencode/custom/plugin/cache-ttl/cache-ttl.js", { "ttl": "1h" }]]
 *
 * Pure JS, no static imports: `.opencode/package.json` is gitignored, so the plugin must not
 * depend on node_modules. That keeps it working on any machine or clone. *
 * ---
 * Author:  Henrique Van Klaveren
 * License: MIT — see LICENSE
 */

const DEFAULTS = {
  /** Master switch. Defaults to TRUE: harmless when there is no marker to stamp. */
  enabled: true,
  /** TTL to stamp. The API accepts only "5m" and "1h". */
  ttl: '1h',
  /**
   * Agent names that get the upgraded TTL. EMPTY (the default) means EVERY agent — the
   * original behaviour, preserved for compatibility.
   *
   * WHY THIS EXISTS (measured on a 12-story pipeline epic, 2026-08-02):
   * a 1h write costs 2.0x input; a 5m write costs 1.25x. Upgrading an agent that never
   * idles past 5 minutes buys nothing and pays 60% more on EVERY write. On that epic,
   * cache write was 8% of the tokens and 59% of the bill — and moving the short-lived
   * agents back to 5m was worth 22% of the total cost.
   * Rule of thumb: list ONLY agents whose sessions sit idle between turns (orchestrators,
   * on-call, interactive work). Agents that run one continuous burst want the 5m price.
   *
   * RESOLUTION: the running agent is read from `--agent <name>` in `process.argv`, because
   * each `opencode run --agent X` is its own process with its own plugin instance.
   * NO `--agent` in argv (i.e. the opencode SERVER, which multiplexes agents in a single
   * process) → the filter cannot discriminate, so the plugin stamps everything, same as before.
   */
  agents: [],
  /** Log one line per modified request (stderr — stdout would corrupt the TUI protocol). */
  debug: false,
}

const VALID_TTLS = ['5m', '1h']

/**
 * Reads the agent name from `--agent <name>` (or `--agent=<name>`) in argv.
 * Returns `null` when absent — the server case, where a single process serves many agents.
 */
function resolveAgentFromArgv(argv) {
  const args = Array.isArray(argv) ? argv : []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--agent') return args[i + 1] ?? null
    if (typeof arg === 'string' && arg.startsWith('--agent=')) return arg.slice('--agent='.length) || null
  }
  return null
}

/**
 * Stamps `ttl` on every `cache_control` in the node. Mutates in depth and counts the changes.
 * Never creates markers: it only touches `cache_control` keys that ALREADY exist.
 */
function stampCacheControl(node, ttl, counter) {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) stampCacheControl(item, ttl, counter)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'cache_control' && value && typeof value === 'object') {
      if (value.ttl !== ttl) {
        value.ttl = ttl
        counter.stamped += 1
      }
      counter.total += 1
      continue
    }
    stampCacheControl(value, ttl, counter)
  }
}

export const CacheTtlPlugin = async (_ctx, options) => {
  const cfg = { ...DEFAULTS, ...(options ?? {}) }

  if (!cfg.enabled) return {}
  if (!VALID_TTLS.includes(cfg.ttl)) {
    console.error(`[cache-ttl] invalid ttl '${cfg.ttl}' (expected ${VALID_TTLS.join('|')}) — plugin INACTIVE`)
    return {}
  }

  // Per-agent gate. An unlisted agent keeps opencode's own markers untouched (= 5m, the cheap write).
  const allow = Array.isArray(cfg.agents) ? cfg.agents : []
  if (allow.length > 0) {
    const agent = resolveAgentFromArgv(process.argv)
    if (agent && !allow.includes(agent)) {
      if (cfg.debug) console.error(`[cache-ttl] agent '${agent}' not in agents=[${allow.join(',')}] — keeping 5m (plugin INACTIVE)`)
      return {}
    }
    if (!agent && cfg.debug) console.error(`[cache-ttl] no --agent in argv (server mode) — filter not applicable, stamping all`)
  }

  const originalFetch = globalThis.fetch
  // Idempotency: a plugin reload must not stack wrappers.
  if (!originalFetch || originalFetch.__cacheTtlWrapped) return {}

  const wrappedFetch = async (input, init) => {
    try {
      const url = typeof input === 'string' ? input : (input?.url ?? String(input))
      const body = init?.body
      if (/anthropic/i.test(url) && typeof body === 'string') {
        const parsed = JSON.parse(body) // throws on non-JSON → caught below, request untouched
        const counter = { total: 0, stamped: 0 }
        stampCacheControl(parsed, cfg.ttl, counter)
        if (counter.stamped > 0) {
          if (cfg.debug) {
            console.error(
              '[cache-ttl]',
              JSON.stringify({ model: parsed.model ?? null, markers: counter.total, stamped: counter.stamped, ttl: cfg.ttl }),
            )
          }
          // New object: never mutate the caller's `init`.
          return originalFetch(input, { ...init, body: JSON.stringify(parsed) })
        }
      }
    } catch {
      /* any failure on our side → the request goes through UNTOUCHED */
    }
    return originalFetch(input, init)
  }

  wrappedFetch.__cacheTtlWrapped = true
  globalThis.fetch = wrappedFetch
  console.error(`[cache-ttl] active — stamping ttl='${cfg.ttl}' on Anthropic cache_control markers`)

  return {
    dispose: async () => {
      if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch
    },
  }
}

export default CacheTtlPlugin
