# Build TODO

Supabase schema is complete — all tables exist, RLS on every table.
This file tracks what code still needs to be written.

---

## Tables in DB (all done, nothing to add)

| Table | Purpose |
|---|---|
| `orgs`, `org_members`, `clients` | Multi-tenant foundation |
| `purchase_register_entries` | Extracted invoices (+ `needs_confirmation`, `confirmed_by`, `confirmed_at`) |
| `gstr2b_entries` | GSTR-2B parsed rows |
| `extraction_jobs` | Job queue for extraction retries |
| `recon_run` | One row per reconciliation run, stores totals + balance status |
| `match_results` | Matcher output with variance, ITC at risk, user review state |
| `recon_audit` | Immutable append-only log of every review action |
| `locked_periods` | Prevents re-runs on filed periods |
| `break_history` | Cross-period break persistence (ageing) |
| `ledger_allocations` | Accepted break decisions reduce ITC at risk |
| `period_snapshots` | End-of-period ledger snapshot |
| `email_routing` | Inbound email → client routing rules |

---

## Code to build

### 1. Audit log writes — in server actions
**File:** `app/(dashboard)/clients/[id]/reconciliation/actions.ts`

Every action (accept, flag, repair) must insert a row into `recon_audit` before
updating `match_results`. Columns: `match_result_id`, `action`, `old_status`,
`new_status`, `resolution_reason`, `note`, `actor` (from `auth.getUser()`), `org_id`.

Currently: `recon_audit` table exists, nothing writes to it.

---

### 2. Period lock guard — in reconcile route
**File:** `app/api/reconcile/route.ts`

At the top of POST, before doing anything:
```ts
const { data: lock } = await db.from('locked_periods')
  .select('id').eq('org_id', orgId).eq('client_id', client_id).eq('period', period).single()
if (lock) return NextResponse.json({ error: 'Period is locked' }, { status: 409 })
```

Add a `POST /api/reconcile/lock` route and a `POST /api/reconcile/unlock` route.
Lock button on the reconciliation page (admin only).

Currently: `locked_periods` table exists, no guard, no routes, no UI.

---

### 3. Extraction job tracking — in upload route
**File:** `app/api/invoices/upload/route.ts`

When a file is received:
1. Insert a row into `extraction_jobs` with `status = 'processing'`.
2. On success: update to `status = 'done'`, `result_entry_id`, `extraction_confidence`.
3. On failure: update to `status = 'failed'`, `last_error`, increment `attempt_count`.
4. If `extraction_confidence < 0.6`: set `status = 'low_confidence'` and set
   `needs_confirmation = true` on the `purchase_register_entries` row.

Currently: upload succeeds or fails silently, no job record, no retry state.

---

### 4. Confirm-fields queue — new page
**File:** `app/(dashboard)/clients/[id]/confirm/page.tsx` (new)

Query: `purchase_register_entries` where `needs_confirmation = true` and
`confirmed_at is null`, ordered by `extraction_confidence asc`.

UI: one row at a time — show extracted fields inline-editable, a "Confirm"
button that writes `confirmed_at = now()`, `confirmed_by = user.id`, clears
`needs_confirmation`. A "Re-extract" button that re-triggers the edge function.

Link from the client detail page: "N invoices need confirmation" badge.

Currently: columns exist, no page, no action, no link.

---

### 5. Break history update — in reconcile route
**File:** `app/api/reconcile/route.ts`

After inserting `match_results`, upsert `break_history`:
- For every non-MATCHED result: upsert on `(client_id, norm_supplier_gstin, norm_inv_no)`.
  - If row exists: increment `periods_open`, update `last_seen_period`, `last_status`,
    `last_itc_at_risk`, `updated_at`.
  - If new: insert with `first_seen_period = period`, `periods_open = 1`.
- For MATCHED results where a `break_history` row exists: set `resolved_at = now()`.

Currently: `break_history` table exists, nothing writes to it.

---

### 6. Ageing report — new page
**File:** `app/(dashboard)/clients/[id]/ageing/page.tsx` (new)

Query `break_history` where `resolved_at is null`, ordered by `periods_open desc`.

Show: supplier GSTIN, first seen period, periods open, last ITC at risk.
Group by how long open: 1 month / 2–3 months / 3+ months (the standard ageing buckets).

Totals row: total ITC at risk across all open breaks.

This is the second output the architecture diagram shows alongside "Recon report".

Currently: `break_history` table exists, no page.

---

### 7. Ledger allocations — in server actions
**File:** `app/(dashboard)/clients/[id]/reconciliation/actions.ts`

When `acceptMatch` is called, also insert into `ledger_allocations`:
```ts
{ org_id, client_id, period, match_result_id: id,
  allocation_type: reason,   // 'tds' | 'rounding' | etc.
  itc_relieved: match.itc_at_risk,
  approved_by: user.id }
```

Currently: `ledger_allocations` table exists, nothing writes to it.

---

### 8. Period snapshot — new action
**File:** `app/api/reconcile/snapshot/route.ts` (new) or button in reconciliation page

When a period is locked, compute and upsert `period_snapshots`:
- `total_itc_claimed` = sum of all 2B tax values for period
- `itc_at_risk` = sum of `match_results.itc_at_risk` where `user_status = 'unreviewed'`
- `itc_relieved` = sum of `ledger_allocations.itc_relieved` for period
- `write_offs_approved` = sum where `allocation_type = 'write_off'`
- `net_itc_risk` = `itc_at_risk - itc_relieved`

Currently: `period_snapshots` table exists, nothing writes to it.

---

## Build order

```
1. Audit writes (actions.ts)         — 1 hour, no new files
2. Period lock guard (reconcile)     — 2 hours, 1 new route
3. Extraction job tracking (upload)  — 2 hours, existing file
4. Break history upsert (reconcile)  — 1 hour, existing file
5. Ledger allocation writes (actions)— 1 hour, existing file
6. Confirm-fields queue              — half day, new page
7. Ageing report                     — half day, new page
8. Period snapshot                   — 2 hours, new route + button
```

Steps 1–5 are all in existing files, no new routes or pages. Do those first.
