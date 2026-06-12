-- Minimal Supabase/Postgres schema for the worker executor queue.
-- Apply this in the Supabase SQL editor or via your migration runner.

create extension if not exists pgcrypto;

create table if not exists public.command_jobs (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  status text not null default 'queued' check (
    status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'needs_human')
  ),
  project text not null,
  executor text not null default 'worker',
  queue text not null default 'default',
  team_id text,
  enterprise_id text,
  channel_id text not null,
  user_id text,
  event_id text,
  message_ts text,
  thread_ts text,
  command_text text not null,
  normalized_command text,
  route_snapshot jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  claimed_by text,
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists command_jobs_status_queue_created_idx
  on public.command_jobs (status, queue, created_at);

create index if not exists command_jobs_event_id_idx
  on public.command_jobs (team_id, event_id)
  where event_id is not null;

create index if not exists command_jobs_message_ts_idx
  on public.command_jobs (team_id, channel_id, message_ts)
  where message_ts is not null;

create or replace function public.set_command_jobs_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_command_jobs_updated_at on public.command_jobs;
create trigger set_command_jobs_updated_at
before update on public.command_jobs
for each row
execute function public.set_command_jobs_updated_at();

-- Recommended: keep RLS enabled and use only the service-role key from the hub/worker runtime.
alter table public.command_jobs enable row level security;
