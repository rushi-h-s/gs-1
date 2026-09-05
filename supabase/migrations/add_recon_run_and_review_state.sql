-- Recon run record + review state columns
-- Run this in Supabase SQL editor

create table if not exists recon_run (
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
  add column if not exists run_id uuid references recon_run(id) on delete cascade,
  add column if not exists taxable_variance numeric default 0,
  add column if not exists tax_variance numeric default 0,
  add column if not exists itc_at_risk numeric default 0,
  add column if not exists evidence jsonb,
  add column if not exists user_status text not null default 'unreviewed'
     check (user_status in ('unreviewed','accepted','flagged','repaired','disputed')),
  add column if not exists resolution_reason text,
  add column if not exists resolution_note text;

create index if not exists match_results_run_id_idx on match_results (run_id, user_status, itc_at_risk desc);
create index if not exists recon_run_client_period_idx on recon_run (client_id, period);

-- RLS for recon_run
alter table recon_run enable row level security;

create policy "org members only" on recon_run
  for all using (
    exists (select 1 from org_members where org_id = recon_run.org_id and user_id = auth.uid())
  );
