-- GST Reconciliation Engine — Schema
-- Run this in Supabase SQL editor

-- One row per CA firm
create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid references auth.users(id) not null
);

-- Staff members of the firm
create table org_members (
  org_id uuid references orgs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'staff')),
  primary key (org_id, user_id)
);

-- Businesses the firm manages
create table clients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs(id) on delete cascade not null,
  name text not null,
  gstin text not null unique
);

-- Uploaded/extracted purchase invoices
create table purchase_register_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid references clients(id) on delete cascade not null,
  period text not null,                      -- 'YYYY-MM'
  supplier_gstin text,
  norm_supplier_gstin text,
  invoice_number text,
  norm_inv_no text,
  invoice_date date,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  extraction_confidence float,
  source text check (source in ('upload', 'email')),
  file_hash text,                            -- SHA-256 for dedup
  created_at timestamptz default now(),
  unique (org_id, file_hash)               -- race-safe dedup guarantee
);

-- GSTR-2B entries from GST portal
create table gstr2b_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid references clients(id) on delete cascade not null,
  period text not null,
  supplier_gstin text,
  norm_supplier_gstin text,
  invoice_number text,
  norm_inv_no text,
  taxable_value numeric,
  cgst numeric,
  sgst numeric,
  igst numeric,
  section text,                              -- 'b2b', 'b2ba', etc.
  created_at timestamptz default now()
);

-- Output of reconciliation run
create table match_results (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid references clients(id) on delete cascade not null,
  period text not null,
  pr_entry_id uuid references purchase_register_entries(id),
  gstr2b_entry_id uuid references gstr2b_entries(id),
  status text not null check (status in ('MATCHED','PROBABLE','MISMATCH','BOOKS_ONLY','TWOB_ONLY')),
  confidence float,
  mismatched_fields text[],
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz default now()
);

-- Email inbound routing rules
create table email_routing (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references orgs(id) on delete cascade not null,
  client_id uuid references clients(id) on delete cascade not null,
  match_from_email text,
  match_subject_prefix text
);

-- Indexes for common queries
create index on purchase_register_entries (client_id, period);
create index on gstr2b_entries (client_id, period);
create index on match_results (client_id, period);

-- RLS
alter table orgs enable row level security;
alter table org_members enable row level security;
alter table clients enable row level security;
alter table purchase_register_entries enable row level security;
alter table gstr2b_entries enable row level security;
alter table match_results enable row level security;
alter table email_routing enable row level security;

-- RLS policies (restrict to org members)
create policy "org members only" on orgs
  for all using (
    exists (select 1 from org_members where org_id = orgs.id and user_id = auth.uid())
  );

create policy "org members only" on org_members
  for all using (user_id = auth.uid());

create policy "org members only" on clients
  for all using (
    exists (select 1 from org_members where org_id = clients.org_id and user_id = auth.uid())
  );

create policy "org members only" on purchase_register_entries
  for all using (
    exists (select 1 from org_members where org_id = purchase_register_entries.org_id and user_id = auth.uid())
  );

create policy "org members only" on gstr2b_entries
  for all using (
    exists (select 1 from org_members where org_id = gstr2b_entries.org_id and user_id = auth.uid())
  );

create policy "org members only" on match_results
  for all using (
    exists (select 1 from org_members where org_id = match_results.org_id and user_id = auth.uid())
  );

create policy "org members only" on email_routing
  for all using (
    exists (select 1 from org_members where org_id = email_routing.org_id and user_id = auth.uid())
  );
