-- break_history, purchase_register_entries.confirmed_*, and bank statement tables.
-- Already applied to production (gst-engine-prod); dev had these from manual edits.
alter table purchase_register_entries
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid;

create table if not exists break_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid not null references clients(id) on delete cascade,
  norm_supplier_gstin text not null,
  norm_inv_no text,
  first_seen_period text not null,
  last_seen_period text not null,
  periods_open int not null default 1,
  last_status text,
  last_itc_at_risk numeric,
  resolved_at timestamptz,
  updated_at timestamptz default now()
);
create index if not exists break_history_client_id_resolved_at_idx on break_history (client_id, resolved_at nulls first);
create index if not exists break_history_org_id_last_itc_at_risk_idx on break_history (org_id, last_itc_at_risk desc);

create table if not exists bank_statement_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid not null,
  period text not null,
  file_name text not null,
  file_hash text not null,
  bank_name text,
  account_number text,
  ifsc text,
  opening_balance numeric not null default 0,
  closing_balance numeric not null default 0,
  txn_count int not null default 0,
  balance_ok boolean not null default false,
  quarantine_reason text,
  created_at timestamptz not null default now(),
  unique (org_id, file_hash)
);
create index if not exists bank_statement_files_org_period on bank_statement_files (org_id, client_id, period);

create table if not exists bank_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  statement_id uuid not null references bank_statement_files(id) on delete cascade,
  client_id uuid not null,
  period text not null,
  txn_date date not null,
  value_date date,
  narration text not null,
  ref_no text,
  debit numeric not null default 0,
  credit numeric not null default 0,
  balance numeric not null default 0,
  counterparty text,
  reference text,
  mode text,
  created_at timestamptz not null default now()
);
create index if not exists bank_transactions_org_period on bank_transactions (org_id, client_id, period);
create index if not exists bank_transactions_date on bank_transactions (org_id, txn_date);

alter table break_history enable row level security;
alter table bank_statement_files enable row level security;
alter table bank_transactions enable row level security;
create policy "org members only" on break_history for all using (exists (select 1 from org_members where org_id = break_history.org_id and user_id = auth.uid()));
create policy "org members only" on bank_statement_files for all using (exists (select 1 from org_members where org_id = bank_statement_files.org_id and user_id = auth.uid()));
create policy "org members only" on bank_transactions for all using (exists (select 1 from org_members where org_id = bank_transactions.org_id and user_id = auth.uid()));
