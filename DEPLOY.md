# Deploying free: Render (app) + Supabase (database)

Free-tier limits change; confirm them on each provider's pricing page.

## 0. Before you start (security)
- Your keys have been printed in terminals and chat sessions. **Rotate** the Supabase service-role key (Supabase → Project Settings → API) and the Gemini / OpenRouter keys, and use the new values below.
- Make sure `.env.local` is not committed (`.env*` is in `.gitignore`; check `git ls-files | grep env`).
- Use a **separate Supabase project for production** from the one your tests write to. The e2e suite creates and deletes `ZZ_E2E_*` clients in whatever `.env.local` points at.

## 1. Push the code to GitHub
Render deploys from a Git repo. Create a **private** GitHub repo and push this folder.

## 2. Supabase (production project)
1. Create a new project (free plan).
2. SQL editor: run `supabase/schema.sql`, then the files in `supabase/migrations/` in date order, ending with `fix_schema_drift.sql` and `20260905_bank_extraction.sql`.
   (Known debt: `clients.gstin` is unique across all orgs — change it to unique per `(org_id, gstin)` before onboarding several firms.)
3. Authentication → Providers → Email: keep enabled. Decide whether to require email confirmation.
4. Copy **Project URL**, **anon key** and **service_role key** (Project Settings → API).

## 3. Render
1. Render dashboard → **New → Blueprint** → select the repo. It reads `render.yaml`.
2. Fill the prompted variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, plus `GEMINI_API_KEY` / `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` if you use extraction. `EMAIL_INBOUND_SECRET` is generated for you.
3. **Do not** set `DEV_AUTH_BYPASS` or `DEV_ORG_ID`.
4. Deploy. First build takes a few minutes. Your URL looks like `https://filewise-gst.onrender.com`.
5. Open `https://<your-url>/api/health` → should show `{"ok":true}`.

`NEXT_PUBLIC_*` values are baked in at build time. If you change them, trigger a new deploy.

## 4. Point Supabase auth at the live URL
Supabase → Authentication → URL Configuration:
- **Site URL**: `https://<your-url>`
- **Redirect URLs**: add `https://<your-url>/**`

Without this, sign-up confirmation emails link to localhost.

## 5. Keep it awake (free tier)
Render's free service sleeps after ~15 min idle (first request then takes ~30–60 s) and a free Supabase project pauses after ~7 days idle.
`.github/workflows/keepalive.yml` pings `/api/health` every 10 minutes (the endpoint runs one tiny DB query).
In the GitHub repo: **Settings → Secrets and variables → Actions → Variables → New** → `APP_URL` = `https://<your-url>`.
(GitHub may disable scheduled workflows after 60 days without repo activity; re-enable them if so. UptimeRobot's free plan pinging `/api/health` every 5 min is an alternative.)

## 6. First login
Open the site → sign up → you land on an empty client list; your firm is created automatically on first sign-in. Add a client, import a GSTR-2B file, reconcile.

## Free-tier realities
- Keep imports to a few thousand rows per file. Render free has small CPU/RAM; 3,000 + 3,000 rows imported in ~9 s and reconciled in ~8 s on a laptop, expect slower there.
- Supabase free: 500 MB database and **no automatic backups**. Export your data regularly.
- Only one Render instance runs, which is what the in-process import lock assumes. Don't scale out without moving that lock into the database.

## CI/CD
- `.github/workflows/ci.yml` runs type-check, lint and unit/fuzz tests on every push and PR.
- Render auto-deploys on push to the default branch. To deploy only after CI passes, set Render → Settings → **Auto-Deploy: After CI Checks Pass**.
- Run `npm run test:e2e` yourself against a non-production project before releases.
