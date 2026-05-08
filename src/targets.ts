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
    url: 'https://slackle-web-production.up.railway.app/healthz',
    expectStatus: 200,
    expectBody: '"ok":true',
    timeout: 10_000,
  },
  {
    name: 'slackle-mapping-ui',
    // /sign-in renders without auth and returns 200 — confirms Vercel + the
    // Next.js app are alive. /api/auth/csrf would be lighter but Slackle's
    // NextAuth setup gates it behind a session cookie.
    url: 'https://slackle-mapping-ui.vercel.app/sign-in',
    expectStatus: 200,
    timeout: 10_000,
  },
  {
    name: 'circlehub',
    url: 'https://circlehub-pi.vercel.app/api/health',
    expectStatus: 200,
    expectBody: '"status":"ok"',
    timeout: 10_000,
  },
  {
    name: 'eventflow',
    // Root redirects to login (307) — confirms the app and Vercel are alive.
    url: 'https://eventflow.confide.group/',
    expectStatus: 307,
    timeout: 10_000,
  },
];
