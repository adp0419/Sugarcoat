-- Run once in the Supabase SQL editor. Only the server (service role) reads this table.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  handle text unique not null check (handle in ('aryan','rohit')),
  twinly_key_enc text,           -- AES-256-GCM (APP_ENCRYPTION_KEY), base64(iv | tag | ciphertext)
  twinly_key_hint text,          -- e.g. "twk_live_…a1b2", shown in Settings
  updated_at timestamptz default now()
);
alter table public.profiles enable row level security;  -- no policies: browser keys get nothing
grant select, insert, update, delete on public.profiles to service_role;

-- Chat history: cleaned text of Aryan <-> Rohit voice messages and call lines.
-- No audio and no raw transcripts. Server-only, like profiles.
create table if not exists public.messages (
  id uuid primary key,
  from_handle text not null check (from_handle in ('aryan','rohit')),
  to_handle text not null check (to_handle in ('aryan','rohit')),
  kind text not null check (kind in ('message','call')),
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_created_at on public.messages (created_at desc);
alter table public.messages enable row level security;
grant select, insert, delete on public.messages to service_role;
