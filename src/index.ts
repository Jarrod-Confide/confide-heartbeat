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
//   state:<name>  =  "up" | "down"
//   last:<name>   =  JSON snapshot of the most recent CheckResult
//
// "unknown" → "up" transitions are NOT alerted (avoids a fake "back up"
// message every time a target's state is first written). Genuine
// transitions in either direction always alert.

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
  const start = Date.now();
  const ts = new Date().toISOString();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), t.timeout ?? 10_000);
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

  const lastState = (await env.STATE.get(stateKey)) ?? 'unknown';
  const newState = r.ok ? 'up' : 'down';
  if (lastState === newState) return;

  // Only write to KV on state transitions to stay within the free-tier
  // write limit (1,000/day). Reads are cheap (100k/day); writes are not.
  await env.STATE.put(stateKey, newState);
  await env.STATE.put(lastKey, JSON.stringify(r));

  // First-ever observation that's healthy — don't alert as if we just
  // recovered.
  if (lastState === 'unknown' && newState === 'up') return;

  const text = formatAlert(r, newState);
  await postSlack(env.ALERT_SLACK_WEBHOOK_URL, text);
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
