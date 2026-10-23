-- Run once in the SAME Supabase project used by the Reminder Website.
-- This migration ADDS tables only; it does not change or delete existing reminders.
create extension if not exists pgcrypto;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  recipient_email text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_email_idx
  on public.push_subscriptions (recipient_email) where enabled = true;

create table if not exists public.push_deliveries (
  id uuid primary key default gen_random_uuid(),
  reminder_id text not null,
  kind text not null check (kind in ('custom','month','week','day')),
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  status text not null check (status in ('processing','sent','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (reminder_id, kind, subscription_id)
);
create index if not exists push_deliveries_subscription_idx
  on public.push_deliveries (subscription_id);

-- These tables contain private push endpoints and keys.
-- They must NEVER be available to anonymous/browser API clients.
alter table public.push_subscriptions enable row level security;
alter table public.push_deliveries enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
revoke all on public.push_deliveries from anon, authenticated;
-- No public/authenticated policies. The trusted server uses a Supabase secret key.
