# Reconciliation Remodel — Break Review Screen

Goal: turn the reconciliation feature from a **recomputed report** into a
**persistent, reviewable break queue** — one break at a time, with an
explanation line and row-level actions (accept / flag / re-pair / view source),
queue ordered by ITC at risk.

Stack stays as-is: Next.js App Router + Supabase. No FastAPI, no HTMX. Server
actions + `revalidatePath` give the "do a thing, replace the row" behaviour.
DaisyUI (CDN) optional for card chrome.

---

## Currently what we have

### Data
`supabase/schema.sql`

- `purchase_register_entries` — extracted purchase invoices, keyed `(client_id, period)`, `unique(org_id, file_hash)` for dedup.
- `gstr2b_entries` — parsed GSTR-2B rows, keyed `(client_id, period)`.
- `match_results` — output of a run. Has `status`, `confidence`, `mismatched_fields`, `reviewed_by`, `reviewed_at`. **No run record, no review status, no notes, no amount variance stored.**

### Matcher
`lib/reconciliation.ts`

- Pure function `reconcile(prEntries, twoBEntries): MatchResult[]`.
- Blocks on `norm_supplier_gstin :: norm_inv_no`, picks candidate with fewest mismatched amount fields.
- 5 buckets: `MATCHED` (≤5% variance on every amount field), `PROBABLE` (≤20%), `MISMATCH` (>20%), `BOOKS_ONLY` (PR unmatched), `TWOB_ONLY` (2B unmatched).
- Returns buckets only — no variance figure, no evidence, no explanation.

### Run endpoint
`app/api/reconcile/route.ts`

- `POST { client_id, period }`.
- **`DELETE from match_results` then `INSERT`** — every re-run wipes all human review. `reviewed_by` / `reviewed_at` are dead columns today.
- Returns `{ counts, total }`.

### UI
`app/(dashboard)/clients/[id]/reconciliation/page.tsx`

- Server component. Summary bar (segmented bar + bucket pills, filter by bucket) + a flat 500-row table.
- CSV export via data URI.
- Read-only. No actions, no queue, no per-row decision, no source document link.

### Gaps this remodel closes
1. Re-runs destroy review decisions.
2. No place to record "accepted as TDS", "flagged to client", a note, or who decided.
3. Matcher throws away the variance amount and the reason — the UI can't explain a break.
4. No worklist model — 500 rows dumped, not "37 open, sorted by value at risk".
5. No re-pair (manual match to a different 2B row).
6. No link back to the source PDF/JSON.

---

## What to do

### 1. Schema — add a run record + review state

New migration:

```sql
create table recon_run (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid references clients(id) on delete cascade not null,
  period text not null,
  created_at timestamptz default now(),
  rules_version text,
  status text not null default 'complete',   -- 'complete' | 'balances_off'
  totals jsonb                               -- {transactions, auto_matched_pct, open_breaks, itc_at_risk}
);

alter table match_results
  add column run_id uuid references recon_run(id) on delete cascade,
  add column taxable_variance numeric default 0,
  add column tax_variance numeric default 0,
  add column itc_at_risk numeric default 0,
  add column evidence jsonb,                  -- {alias_hits, field_confidence, source_page, ...}
  add column user_status text not null default 'unreviewed'
     check (user_status in ('unreviewed','accepted','flagged','repaired','disputed')),
  add column resolution_reason text,          -- 'tds' | 'tcs' | 'rounding' | 'freight' | 'refiling' | 'other'
  add column resolution_note text;

create index on match_results (run_id, user_status, itc_at_risk desc);
```

Match identity across re-runs: key on `(norm_supplier_gstin, norm_inv_no, period)`.
On a new run, carry forward `user_status` + notes for keys whose underlying
amounts are unchanged; reset to `unreviewed` if the invoice changed.
`// ponytail: composite-key carry-forward, revisit if refiling churn is noisy`

### 2. Matcher — emit variance + evidence

`lib/reconciliation.ts`:

- `MatchResult` gains `taxable_variance`, `tax_variance`, `itc_at_risk`, `evidence`.
- Compute signed variance (PR − 2B) on taxable and on total tax; `itc_at_risk = abs(tax_variance)` for MISMATCH/PROBABLE, full tax for BOOKS_ONLY/TWOB_ONLY.
- `evidence`: pull supplier-alias hit count and `extraction_confidence` from the PR entry, plus source page if available.

### 3. `explainBreak(match): string` — new pure helper

`lib/explain-break.ts`. Switch on bucket + variance pattern:

| Pattern | Line |
|---|---|
| variance ≈ 1% / 2% / 5% / 10% of taxable | "Difference ₹X — matches N% TDS/TCS on invoice value." |
| invoice no differs by ±1 char / check digit | "GSTIN matches; invoice number differs by one character — likely a typo." |
| 2B period = booked period + 1 | "Supplier filed this in {next period}'s 2B; booked in {period}." |
| small rounding (< ₹5) | "Rounding difference." |
| BOOKS_ONLY | "Booked but not yet in 2B — supplier may not have filed." |
| TWOB_ONLY | "In 2B but not booked — invoice may be missing from the register." |
| else | "Amounts differ by ₹X ({pct}%)." |

One `assert`-based self-check in the file covering the TDS and refiling cases.

### 4. Run endpoint — insert a run, stop wiping review

`app/api/reconcile/route.ts`:

- Insert one `recon_run` row, get `run_id`.
- Insert `match_results` with `run_id` + variance + evidence.
- Replace `DELETE all` with the carry-forward step from §1.
- Compute `recon_run.totals` and `status` (`balances_off` if PR tax total − 2B tax total is material).

### 5. Server actions

`app/(dashboard)/clients/[id]/reconciliation/actions.ts`:

```
acceptMatch(id, reason)      -> user_status='accepted', reviewed_by/at, revalidatePath
flagMatch(id, note)          -> user_status='flagged', resolution_note
repairMatch(id, newTwoBId)   -> relink gstr2b_entry_id, recompute variance + bucket, user_status='repaired'
acceptAllMatched(runId)      -> bulk accept every MATCHED in the run
```

All org-scoped via `getDbAndOrg()`.

### 6. UI — break review screen

Rework `reconciliation/page.tsx` (or a new `/review` sub-route):

- **Header**: client name · `period · GSTIN · run {time}, rules {version}` · `balances tied` / `balances off` badge from `recon_run`.
- **Metric strip**: Transactions · Auto-matched % · Open breaks · ITC at risk — from `recon_run.totals`.
- **One break card** driven by `?break=<n>`, queue = `user_status='unreviewed'` ordered by `itc_at_risk desc`:
  - bucket badge + "break n of N"
  - two columns: Purchase register invoice vs GSTR-2B invoice (no, supplier, date, amount)
  - `explainBreak()` line + evidence ("alias confirmed 14×", "read at high confidence")
  - buttons → server actions: Accept (with reason picker), Flag to client, Re-pair, View source
  - keyboard: `A` accept, `F` flag, `→` next
- Keep the segmented summary bar and CSV export.
- Reference layout: `break_review_screen_mockup.html`.

### 7. Client-facing flagged list (small)

A filter on the same page: `user_status='flagged'` → the list the CA sends back to the client. No new screen.

---

## Build order

1. Migration (§1) — load-bearing, do first.
2. Matcher variance + `explainBreak` (§2, §3) — independent, testable offline.
3. Run endpoint (§4) — wires 1+2 together.
4. Server actions (§5).
5. UI (§6) — visual proof against real data.
6. Flagged filter (§7).

Rough effort: migration + matcher ~2 days, endpoint + actions ~1 day,
UI ~1 day, explain/polish ~½ day.
