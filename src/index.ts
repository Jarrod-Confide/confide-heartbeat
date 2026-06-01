// Cloudflare Worker — Confide Heartbeat.
// Uptime monitor for every Confide service.
//
// Runs on a 1-minute cron (configured in wrangler.toml). On each tick:
//   1. Fetches every target in src/targets.ts in parallel.
//   2. For each, compares the result to the last-known state in KV.
//   3. On a state transition, posts to the Slack webhook in #system-status.
//   4. Stays silent when state is stable (no per-minute spam).
//
// Also exposes:
//   GET /         — small status page summarising last results in KV
//   GET /check    — runs a check synchronously and returns JSON (manual probe)
//
// State in KV:
//   state:<name>      =  "up" | "down"
//   last:<name>       =  JSON snapshot of the most recent CheckResult
//   pending_fails:<n> =  count of consecutive failed ticks while state is "up"
//                        (caps at DOWN_THRESHOLD so a long outage doesn't burn
//                        KV write budget)
//
// "unknown" → "up" transitions are NOT alerted (avoids a fake "back up"
// message every time a target's state is first written). Genuine
// transitions in either direction always alert.
//
// Noise suppression:
//   1. checkOne retries once with a tighter timeout on the first failure
//      before declaring the probe bad. Catches transient blips inside a
//      single cron tick (CF edge DNS hiccup, brief egress queueing).
//   2. UP → DOWN requires DOWN_THRESHOLD consecutive failed ticks before
//      we transition and alert. DOWN → UP is still instant so recovery
//      notifications stay snappy.
//   3. Default timeout is 15s (was 10s). The endpoints we probe do real
//      work (DB + Redis + cable checks for Slackle's /readyz, Next.js
//      middleware for the Vercel apps) — 10s was tight enough to false-
//      positive whenever a target was warming up.
//
// Trade-off: a *real* sustained outage now alerts in 2 minutes instead
// of 1. Acceptable; recovery alerts are still 1-tick.

const DOWN_THRESHOLD = 2;
const DEFAULT_TIMEOUT_MS = 15_000;
const RETRY_TIMEOUT_MS = 5_000;

import { TARGETS, type Target } from './targets';

interface Env {
  STATE: KVNamespace;
  ALERT_SLACK_WEBHOOK_URL: string;
}

interface CheckResult {
  name: string;
  ok: boolean;
  status: number;
  bodyMatches?: boolean;
  error?: string;
  durationMs: number;
  ts: string;
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runAll(env));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/check') {
      const results = await runAll(env);
      return Response.json({ results });
    }
    if (url.pathname === '/' || url.pathname === '/status') {
      return Response.json({ targets: await getStatusSnapshot(env) });
    }
    return new Response(
      'uptime monitor — GET / for state, GET /check to force a run\n',
      { status: 200, headers: { 'content-type': 'text/plain' } },
    );
  },
};

async function runAll(env: Env): Promise<CheckResult[]> {
  const results = await Promise.all(TARGETS.map(checkOne));
  await Promise.all(results.map((r) => processResult(env, r)));
  return results;
}

async function checkOne(t: Target): Promise<CheckResult> {
  // First attempt at the configured timeout (default 15s).
  const first = await probeOnce(t, t.timeout ?? DEFAULT_TIMEOUT_MS);
  if (first.ok) return first;
  // Single retry on failure. Most flaps we've seen are transient CF-edge
  // timeouts that resolve in a second or two — a quick retry eats them
  // without doubling our alert latency on real outages. Tighter timeout
  // (5s) so the worker still finishes well within its 30s budget even
  // when all targets fail and all retry.
  const second = await probeOnce(t, RETRY_TIMEOUT_MS);
  if (second.ok) return second;
  // Both attempts failed — return the first result, since its error is
  // typically more representative (the retry's 5s timeout would mask a
  // slow-but-eventually-responding target as a fast failure).
  return first;
}

async function probeOnce(t: Target, timeoutMs: number): Promise<CheckResult> {
  const start = Date.now();
  const ts = new Date().toISOString();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(t.url, {
      method: 'GET',
      signal: ctrl.signal,
      // Don't follow redirects: if a target intends to redirect (e.g.
      // EventFlow's root → /sign-in), our `expectStatus` should match
      // the 3xx, not the 200 from the redirect destination. Following
      // redirects was hiding eventflow's actual response and producing
      // an undetected up/down mismatch.
      redirect: 'manual',
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    clearTimeout(timer);
    let bodyMatches: boolean | undefined;
    if (t.expectBody) {
      const body = await res.text();
      bodyMatches = body.includes(t.expectBody);
    }
    const ok = res.status === t.expectStatus && bodyMatches !== false;
    return {
      name: t.name,
      ok,
      status: res.status,
      bodyMatches,
      durationMs: Date.now() - start,
      ts,
    };
  } catch (err) {
    return {
      name: t.name,
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      ts,
    };
  }
}

async function processResult(env: Env, r: CheckResult) {
  const stateKey = `state:${r.name}`;
  const lastKey = `last:${r.name}`;
  const pendingKey = `pending_fails:${r.name}`;

  const lastState = (await env.STATE.get(stateKey)) ?? 'unknown';
  const pendingFails = Number((await env.STATE.get(pendingKey)) ?? '0');

  // ── Successful probe ────────────────────────────────────────────────────
  if (r.ok) {
    // Clear any pending-fail counter so a single recovery erases the
    // half-step toward DOWN. This is the "blip" case — one bad tick
    // followed by a good one, no alert ever fires.
    if (pendingFails > 0) await env.STATE.put(pendingKey, '0');

    if (lastState === 'up') return; // stable up — no writes, no alert
    if (lastState === 'unknown') {
      await env.STATE.put(stateKey, 'up'); // first-ever observation — no alert
      return;
    }
    // lastState === 'down' → genuine recovery
    await env.STATE.put(stateKey, 'up');
    await env.STATE.put(lastKey, JSON.stringify(r));
    await postSlack(env.ALERT_SLACK_WEBHOOK_URL, formatAlert(r, 'up'));
    return;
  }

  // ── Failed probe ────────────────────────────────────────────────────────
  if (lastState === 'down') return; // already alerted; nothing new
  // We're either UP or unknown. Bump the pending counter toward DOWN.
  const newPending = Math.min(pendingFails + 1, DOWN_THRESHOLD);
  if (newPending < DOWN_THRESHOLD) {
    // Not enough consecutive failures yet — record the half-step but
    // don't alert. Next tick decides.
    await env.STATE.put(pendingKey, String(newPending));
    return;
  }
  // Threshold met. Transition to DOWN and alert.
  await env.STATE.put(stateKey, 'down');
  await env.STATE.put(lastKey, JSON.stringify(r));
  // Cap the counter at threshold so a sustained outage stops burning writes.
  if (pendingFails !== DOWN_THRESHOLD) {
    await env.STATE.put(pendingKey, String(DOWN_THRESHOLD));
  }
  await postSlack(env.ALERT_SLACK_WEBHOOK_URL, formatAlert(r, 'down'));
}

function formatAlert(r: CheckResult, newState: 'up' | 'down'): string {
  if (newState === 'down') {
    if (r.error) return `:rotating_light: *${r.name}* DOWN — ${r.error}`;
    if (r.bodyMatches === false) {
      return `:rotating_light: *${r.name}* DOWN — got ${r.status} but body check failed`;
    }
    return `:rotating_light: *${r.name}* DOWN — got HTTP ${r.status}`;
  }
  return `:white_check_mark: *${r.name}* back UP (${r.durationMs}ms)`;
}

async function postSlack(url: string, text: string) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        username: 'Confide Heartbeat',
        icon_emoji: ':heartbeat:',
      }),
    });
  } catch (err) {
    // Best effort. If Slack is the thing that's down, we can't tell anyone.
    console.error('postSlack failed', err);
  }
}

async function getStatusSnapshot(
  env: Env,
): Promise<Array<{ name: string; state: string; last?: CheckResult }>> {
  return Promise.all(
    TARGETS.map(async (t) => {
      const state = (await env.STATE.get(`state:${t.name}`)) ?? 'unknown';
      const lastRaw = await env.STATE.get(`last:${t.name}`);
      const last = lastRaw ? (JSON.parse(lastRaw) as CheckResult) : undefined;
      return { name: t.name, state, last };
    }),
  );
}
