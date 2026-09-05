-- Run this once against your Supabase project if the table already exists
-- (schema.sql already includes this for fresh installs)
alter table purchase_register_entries
  add constraint purchase_register_entries_org_file_hash_unique
  unique (org_id, file_hash);
