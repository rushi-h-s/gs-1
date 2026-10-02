# Testing

| Command | What it runs | Needs |
|---|---|---|
| `npm test` | Unit + property/fuzz tests (parsers, normaliser, matcher). Seconds. | nothing |
| `npm run check` | `tsc` + `eslint` + `npm test` — run before every commit; CI runs it. | nothing |
| `npm run test:e2e` | Boots the real app and exercises it against the real Supabase project. Minutes. | `.env.local` |

## Layers
1. **`tests/unit/gst.test.ts`** — fixed examples: every file layout we support, the Acme golden cases, rupee tolerances, plus your sample files in `D:/git/gst 2b` when present.
2. **`tests/unit/invariants.test.ts`** — thousands of seeded random inputs asserting rules that must always hold
   (every PR and 2B row reported exactly once, never double-used, no crash on any garbage file).
   Reproduce a failure with `SEED=<n> npm test`.
3. **`tests/e2e/auth.e2e.test.ts`** — signed-out callers get 401 / redirect on **every** API route and page. Routes are discovered from the file tree, so a new unprotected route fails the suite.
4. **`tests/e2e/data.e2e.test.ts`** — golden bucket counts, idempotent re-import/re-run, review decisions surviving a re-run, locked periods, a bad-input matrix (never 5xx, never changes stored data), atomicity, concurrency.
5. **`tests/e2e/scale.e2e.test.ts`** — thousands of rows through import → reconcile → page render, cross-checked against the pure matcher (catches truncation, loss and duplication). `SCALE_ROWS=10000 npm run test:e2e` to push harder.

E2E tests only ever touch clients named `ZZ_E2E_*`, delete them afterwards, and sweep leftovers from crashed runs at start-up.
They run the dev server with `DEV_AUTH_BYPASS=true` for the data suites and without it for the auth suite.

**Not covered by automation:** a real signed-in browser session (sign-up → first-login org creation → RLS). Do that by hand after auth changes.
