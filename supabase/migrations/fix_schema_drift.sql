-- Fix schema drift: add all columns/tables the code expects
-- Run this in Supabase SQL editor

-- purchase_register_entries: rename/add columns
alter table purchase_register_entries
  add column if not exists inv_no text,
  add column if not exists norm_inv_no text,
  add column if not exists inv_date date,
  add column if not exists is_rcm boolean default false,
  add column if not exists doc_type text default 'invoice',
  add column if not exists needs_confirmation boolean default false;

-- Copy existing data from old column names if they exist and new ones are empty
update purchase_register_entries
  set inv_no = invoice_number where inv_no is null and invoice_number is not null;
update purchase_register_entries
  set inv_date = invoice_date where inv_date is null and invoice_date is not null;

-- gstr2b_entries: add inv_no / norm_inv_no aliases
alter table gstr2b_entries
  add column if not exists inv_no text,
  add column if not exists norm_inv_no text,
  add column if not exists inv_date date;

update gstr2b_entries
  set inv_no = invoice_number where inv_no is null and invoice_number is not null;

-- extraction_jobs table
create table if not exists extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid references clients(id) on delete cascade not null,
  period text not null,
  file_name text,
  file_hash text,
  status text not null default 'processing'
    check (status in ('processing','done','failed','low_confidence')),
  attempt_count int default 0,
  last_error text,
  result_entry_id uuid references purchase_register_entries(id) on delete set null,
  extraction_confidence float,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists extraction_jobs_client_period on extraction_jobs (client_id, period);

alter table extraction_jobs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'extraction_jobs' and policyname = 'org members only') then
    create policy "org members only" on extraction_jobs
      for all using (exists (select 1 from org_members where org_id = extraction_jobs.org_id and user_id = auth.uid()));
  end if;
end $$;

-- locked_periods table
create table if not exists locked_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  client_id uuid references clients(id) on delete cascade not null,
  period text not null,
  locked_at timestamptz default now(),
  locked_by uuid references auth.users(id),
  unique (org_id, client_id, period)
);

alter table locked_periods enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'locked_periods' and policyname = 'org members only') then
    create policy "org members only" on locked_periods
      for all using (exists (select 1 from org_members where org_id = locked_periods.org_id and user_id = auth.uid()));
  end if;
end $$;
