-- Dedicated access-link abuse budget (shared Reminder Website database).
-- No existing reminder rows or email schedules are changed.
create table if not exists public.reminder_access_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  email_hash text not null,
  created_at timestamptz not null default now()
);
create index if not exists reminder_access_attempts_ip_time_idx
  on public.reminder_access_attempts(ip_hash, created_at desc);
create index if not exists reminder_access_attempts_email_time_idx
  on public.reminder_access_attempts(email_hash, created_at desc);

alter table public.reminder_access_attempts enable row level security;
revoke all on public.reminder_access_attempts from public, anon, authenticated;
grant select, insert, delete on public.reminder_access_attempts to service_role;
grant usage, select on sequence public.reminder_access_attempts_id_seq to service_role;

-- Race-safe throttling enforced by Postgres transaction locks.
-- SECURITY INVOKER, not SECURITY DEFINER; only service_role may call this API function.
create or replace function public.record_reminder_access_attempt(
  p_ip_hash text, p_email_hash text
) returns boolean
language plpgsql security invoker set search_path = ''
as $$
declare
  v_since timestamptz := now() - interval '15 minutes';
  v_ip_count bigint;
  v_email_count bigint;
begin
  if length(p_ip_hash) <> 64 or length(p_email_hash) <> 64
      or p_ip_hash !~ '^[0-9a-f]{64}$' or p_email_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('email:' || p_email_hash, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ip:' || p_ip_hash, 0));

  select count(*) into v_ip_count
    from public.reminder_access_attempts
    where ip_hash = p_ip_hash and created_at >= v_since;
  select count(*) into v_email_count
    from public.reminder_access_attempts
    where email_hash = p_email_hash and created_at >= v_since;

  if v_ip_count >= 8 or v_email_count >= 4 then return false; end if;
  insert into public.reminder_access_attempts(ip_hash, email_hash)
    values(p_ip_hash, p_email_hash);
  return true;
end $$;

revoke all on function public.record_reminder_access_attempt(text,text) from public, anon, authenticated;
grant execute on function public.record_reminder_access_attempt(text,text) to service_role;
