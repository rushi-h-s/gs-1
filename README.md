# GST Reconciliation Engine

A web app for CA firms to reconcile GSTR-2B (purchase) data against internal invoices and flag mismatches.

## Project Path

```
D:\git\gst-engine
```

## Tech Stack

- **Framework:** Next.js 16 (App Router, Turbopack)
- **Database & Auth:** Supabase (PostgreSQL + Row Level Security)
- **Styling:** Tailwind CSS
- **Language:** TypeScript
- **Deployment:** Vercel

## Features

- Client management (add clients with GSTIN)
- Invoice upload and parsing
- GSTR-2B upload and parsing
- Reconciliation engine — matches invoices against GSTR-2B, flags mismatches
- Email inbound support for automated uploads

## Getting Started

```powershell
cd D:\git\gst-engine
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

Create `.env.local` with:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
DEV_ORG_ID=...   # temporary, for dev without auth
```

## Project Structure

```
app/
  (auth)/login/       # Login page (bypassed in dev)
  (dashboard)/        # Main app — clients, reconciliation
  api/
    clients/          # CRUD for clients
    invoices/upload/  # Invoice PDF/Excel upload
    gstr2b/upload/    # GSTR-2B JSON upload
    reconcile/        # Reconciliation engine
    email-inbound/    # Inbound email webhook
utils/supabase/       # Supabase client helpers
supabase/migrations/  # DB schema migrations
```

## Dev Notes

- Auth is currently bypassed for testing (middleware and dashboard layout have guards commented out)
- `DEV_ORG_ID` in `.env.local` is used as the fallback org when no user is logged in
- Re-enable auth by restoring the redirect in `utils/supabase/middleware.ts` and `app/(dashboard)/layout.tsx`
