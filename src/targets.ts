// List of services this monitor checks. Add a new entry to start watching
// a new app; redeploy via `npm run deploy`. Each target is hit once per
// cron run (every minute).
//
// Fields:
//   name          short identifier shown in alerts (e.g. "slackle-web")
//   url           full URL to hit (use a cheap health endpoint, not the homepage)
//   expectStatus  HTTP status that means "healthy"
//   expectBody    optional substring that must be present in the response
//                 body for the target to be considered up. Skip for endpoints
//                 that return non-deterministic bodies.
//   timeout       request timeout in ms (default 10s)
//
// Picking the right URL: prefer a dedicated /health or /healthz endpoint.
// If a service requires auth on its main routes, use whatever public
// readiness probe it exposes. Avoid full-page renders — they're slow and
// can hide partial failures.

export interface Target {
  name: string;
  url: string;
  expectStatus: number;
  expectBody?: string;
  timeout?: number;
}

export const TARGETS: Target[] = [
  {
    name: 'slackle-web',
    // /readyz checks DB, Redis, AND the Circle cable (with a 2-min grace
    // so normal Circle restarts don't trip it). /healthz would just
    // confirm the Node process is alive, which misses the failure mode
    // we saw in the 5/9 → 5/11 cable outage where the process was up
    // but the cable inside it was dead.
    url: 'https://slackle-web-production.up.railway.app/readyz',
    expectStatus: 200,
    expectBody: '"ok":true',
    timeout: 15_000,
  },
  {
    name: 'slackle-mapping-ui',
    // /sign-in renders without auth and returns 200 — confirms Vercel + the
    // Next.js app are alive. /api/auth/csrf would be lighter but Slackle's
    // NextAuth setup gates it behind a session cookie.
    url: 'https://slackle-mapping-ui.vercel.app/sign-in',
    expectStatus: 200,
    timeout: 15_000,
  },
  {
    name: 'circlehub',
    url: 'https://circlehub-pi.vercel.app/api/health',
    expectStatus: 200,
    expectBody: '"status":"ok"',
    timeout: 15_000,
  },
  {
    name: 'eventflow',
    // Root redirects to login (307) — confirms the app and Vercel are alive.
    url: 'https://eventflow.confide.group/',
    expectStatus: 307,
    timeout: 15_000,
  },
  {
    name: 'meq',
    // Purpose-built health route (public in middleware) that pings all three
    // DBs — meq, eventflow, slackle — and returns 200 {"ok":true} only if
    // every dependency is reachable, else 503. Catches DB outages, not just
    // "is the Next.js process alive".
    url: 'https://meq.confide.group/api/health',
    expectStatus: 200,
    expectBody: '"ok":true',
    timeout: 15_000,
  },
  {
    name: 'catalyst',
    // Customer-facing, so an outage here is seen by CISOs and vendors, not
    // just staff. /api/health checks the Supabase connection and returns
    // {"ok":true,"db":"up"}, so a dead pooler trips it, not just a dead app.
    url: 'https://catalyst.confide.group/api/health',
    expectStatus: 200,
    expectBody: '"ok":true',
    timeout: 15_000,
  },
  {
    name: 'pulse',
    // Same health route shape as Catalyst. Pulse is a dependency of the other
    // apps' feedback flows, so its outages are felt second-hand elsewhere.
    url: 'https://pulse.confide.group/api/health',
    expectStatus: 200,
    expectBody: '"ok":true',
    timeout: 15_000,
  },
  {
    name: 'confide-apps',
    // The apps.confide.group directory. It has no database, so the health
    // route only proves the app is serving -- which is all there is to prove.
    // It also renders this worker's own status snapshot, so when it is down
    // the estate loses its status page as well as its launcher.
    url: 'https://apps.confide.group/api/health',
    expectStatus: 200,
    expectBody: '"ok":true',
    timeout: 15_000,
  },
];
