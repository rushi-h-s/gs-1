# GST Reconciliation Engine (gs1)

A multi-tenant web app for CA firms to reconcile GSTR-2B (purchase) data against purchase invoices and bank statements, and to review the mismatches ("breaks").

## Tech Stack

- **Framework:** Next.js 16 (App Router, Turbopack), TypeScript, Tailwind CSS
- **Database & Auth:** Supabase (PostgreSQL + Row Level Security, email auth)
- **Extraction:** Gemini / OpenRouter for invoice and bank-statement parsing, with a regex fallback
- **Hosting:** Azure App Service (live), Render (`render.yaml`), or the included `Dockerfile`

## Features

- Orgs and clients (GSTIN per client)
- Invoice upload: PDF, image or JSON, extracted by regex first and LLM/vision when needed
- GSTR-2B upload and check
- Bank statement upload and extraction
- Reconciliation: deterministic matching with a break reason, ageing (`first_seen_at`) and a review queue with accept/flag actions
- Reconcile lock, snapshot and unlock (the lock is in-process, so run a single instance)
- Inbound-email webhook, protected by `x-webhook-secret`
- Agent chat endpoint

## Getting Started

```powershell
npm install
copy .env.example .env.local   # then fill in the values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Other scripts: `npm run build`, `npm start`, `npm run lint`, `npm test` (unit tests). See `TESTING.md` for the e2e suite.

## Environment Variables

See `.env.example`. In short:

| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Inlined at build time, so rebuild after changing them |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only |
| `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Optional; without keys extraction falls back to regex |
| `EMAIL_INBOUND_SECRET` | Without it the inbound webhook refuses everything |
| `DEV_AUTH_BYPASS`, `DEV_ORG_ID` | Local dev only, ignored in production builds. Never set in production |

Values in `.env.local` may be quoted. Strip the quotes when copying them into a host's settings.

## Project Structure

```
app/
  (auth)/login/        # Login page
  (dashboard)/         # Clients, data, reconciliation, ageing, confirm
  api/
    clients/           # Client CRUD
    invoices/upload/   # Invoice PDF / image / JSON upload
    gstr2b/            # GSTR-2B upload and check
    bank-statements/   # Bank statement upload
    reconcile/         # Reconcile, lock, unlock, snapshot
    email-inbound/     # Inbound email webhook
    agent/chat/        # Agent chat
    orgs/ auth/ health/
lib/                   # Matching, extraction, lock, db helpers
supabase/              # schema.sql and migrations
tests/                 # Unit and e2e tests
```

## Deployment

Needs Node 22 or newer.

- **Render + Supabase:** see `DEPLOY.md`.
- **Azure App Service** (currently live at https://gs1-rushi.azurewebsites.net, free F1 plan):
  1. `npm run build` (uses `output: 'standalone'`).
  2. Zip `.next/standalone` plus `.next/static` and `public` copied into it. Leave out `node_modules/@img/sharp-win32-x64` when building on Windows.
  3. `az webapp deploy -g gs1-rg -n gs1-rushi --src-path app.zip --type zip`, with startup command `node server.js` and app settings from `.env.example` plus `HOSTNAME=0.0.0.0`.
- **Docker:** the `Dockerfile` builds a standalone image. `NEXT_PUBLIC_*` values are passed as `--build-arg`.

After deploying, set the Supabase Auth **Site URL** and **Redirect URLs** (`https://<your-url>/**`), and check `/api/health` returns `{"ok":true}`.

Run a **single instance** until the in-process lock is replaced with Postgres advisory locks.

## More Docs

`ARCHITECTURE.md`, `DEPLOY.md`, `TESTING.md`, `BUILD_TODO.md`, `RECON_REMODEL.md`.
