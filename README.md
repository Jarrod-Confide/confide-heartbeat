# Confide Heartbeat

Cloudflare Worker that pings every Confide service every minute and posts to `#system-status` in Slack on state transitions.

## What it monitors

See `src/targets.ts` for the live list. Initial set:

- `slackle-web` — Slackle backend on Railway (`/healthz`)
- `slackle-mapping-ui` — Slackle admin UI on Vercel (`/sign-in`)
- `circlehub` — HubSpot ↔ Circle sync on Vercel (`/api/health`)

Add a new service: append a `Target` to `src/targets.ts`, run `npm run deploy`. Done.

## Why Cloudflare Workers (not Railway / Vercel / GitHub Actions)

A monitor can't share infra with the thing it's monitoring — when Railway goes down, a Railway-based monitor goes down too and can't alert. Cloudflare Workers run on edge infrastructure that's totally independent of Railway and Vercel. Free tier (100k req/day) is way more than we'll use; the 1-minute cron resolution beats GitHub Actions' frequently-delayed 5-minute schedule.

## One-time setup

Requires Node.js + npm. Run from this directory.

```bash
npm install                                    # install wrangler + types
npx wrangler login                             # opens browser, authorizes Cloudflare
npx wrangler kv namespace create STATE         # creates KV — copy the id it prints
```

Open `wrangler.toml`, paste the KV namespace id where it says `REPLACE_WITH_KV_NAMESPACE_ID`.

```bash
npx wrangler secret put ALERT_SLACK_WEBHOOK_URL
# When prompted, paste the Slack incoming-webhook URL for #system-status
# (same URL Slackle's alerts watcher uses).

npm run deploy                                 # ships the worker
```

After deploy, Cloudflare prints the worker's URL (e.g. `https://uptime-monitor.<account>.workers.dev`). The cron is already active — no further action.

## Day-to-day

```bash
npm run tail            # stream live worker logs (handy when adding a target)
npm run deploy          # redeploy after editing targets.ts
```

The worker exposes two HTTP routes for quick checks:

- `GET /` — last-known state per target (no probe; just reads KV)
- `GET /check` — runs all checks immediately and returns JSON

## Alert behaviour

| Transition | Slack message |
| --- | --- |
| `up → down` | `🚨 <name> DOWN — <reason>` |
| `down → up` | `✅ <name> back UP (<ms>ms)` |
| stays up or down | (silent — no per-minute spam) |
| first-ever check is up | (silent — initial baseline) |

State is kept in Cloudflare KV (`state:<name>` and `last:<name>`). Survives redeploys.

## Adding a new service

1. Open `src/targets.ts`
2. Append:
   ```ts
   {
     name: 'eventflow',
     url: 'https://eventflow.example.com/api/health',
     expectStatus: 200,
     expectBody: '"ok":true',
     timeout: 10_000,
   }
   ```
3. `npm run deploy`

The next cron tick picks it up. First successful check sets the baseline silently; first failure alerts.
