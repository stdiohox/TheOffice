# Brightwork Office demo - standing rules

A sales demo of Koret's virtual office. The screens, hooks, SQL and email templates are copied
from a client's live office (the registry entry says which) and then rebranded to a fictional
company; the demo adds five features and a presenter layer. It has no backend: Postgres runs in
the visitor's browser. Registered in Koret Tech's `clients/registry.md`.

## Never

- **No real people, clients or data.** Everyone in `src/demo/people.ts` is invented, emails use
  `brightwork.example`. No client's names, logos or figures, ever. This repo may be shown to prospects.
- **Nothing leaves the browser.** No Supabase project, no Resend, no analytics. Emails stop at the
  Email log. If that ever changes, the "runs entirely in this browser" line in `DemoPanel` is a lie.

## How it works

- `src/lib/supabase.ts` still hands the app the real supabase-js client, built in
  `src/demo/client.ts` with its fetch, channels and storage swapped. Keep app code unaware of the demo.
- `src/demo/db.worker.ts`: PGlite in a SharedWorker, one Postgres for all windows. Do NOT go back to
  `@electric-sql/pglite/worker`: its leader election hung reloads of a second window.
- `src/demo/rest.ts`: PostgREST translated to SQL, run as the caller, so RLS is real. It covers what
  the app asks for; a new query shape may need a new branch here.
- `server/`: the real API routes, called in the browser by `src/demo/routes.ts`. Not Vercel
  functions, which is why the folder is not `api/`.
- `scripts/demo/build-db.mjs`: applies `supabase/migrations/` in order and writes the snapshot
  `public/demo/office.tar.gz` (not committed). It replaces `now()` with `demo.now()` so the clock can move.
- `src/demo/seed.ts`: the sample month, written relative to "today". `src/demo/sim.ts`: the rest of
  the team, through the same functions a person's browser calls.
- New table: a migration in `supabase/migrations/` as usual. `demo.capture` triggers and realtime
  come for free. New rows the seed writes must also be cleared in `wipe()`.

## Process

- **npm only** (`package-lock.json`). A stray `bun.lock` or `pnpm-lock.yaml` is deleted, reported, never committed.
- `npm run build` must pass. Never build while `vite` dev is running.
- Before shipping: `node scripts/demo/e2e/walkthrough.mjs` and `reloads.mjs` against `vite preview --port 5199`
  (the production build differs from dev, and has broken where dev worked).
- **Deploy by CLI** from a clean copy (see the registry entry), pinned `vercel@64.7.0`.

## The office's own rules still apply

The monitoring limits (NDPA 2023 levels A to C: no screenshots, keystrokes, webcam or covert
monitoring) stay true of this code. `src/lib/officeNotice.ts` must stay true of the code too: if the
office starts recording something new, the notice changes first. A demo pitches a product someone
will really buy, so it must not promise what the real thing would not do.

## Writing

- Zero em-dashes in anything a person reads. Plain words.
- Never present a figure as real: everything is sample data, and says so.
- Font is Nunito; the green tokens in `src/index.css` are unchanged from the source office so the
  demo looks the same. A client-branded version changes tokens, `public/mark.svg` and the wordmark only.
