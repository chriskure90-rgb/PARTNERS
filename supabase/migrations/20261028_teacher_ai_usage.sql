-- Teachers' AI requests per day (UTC), one shared count across every
-- teacher-facing AI Edge Function. Only the server (service role) uses it,
-- through use_teacher_ai_request; teachers can't read or change it.

create table if not exists public.teacher_ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  request_count integer not null default 0 check (request_count >= 0),
  primary key (user_id, usage_date)
);

alter table public.teacher_ai_usage enable row level security;
-- No policies: no access for anon or authenticated users.

-- Counts one AI request for the teacher today (UTC) if they're under the
-- limit, in one statement (concurrent requests can't both pass the last
-- slot). Returns the requests left after this one, or -1 when today's are
-- used up (then nothing is counted).
create or replace function public.use_teacher_ai_request(p_user_id uuid, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_user_id is null or p_limit is null or p_limit < 1 then
    return -1;
  end if;
  insert into public.teacher_ai_usage as u (user_id, usage_date, request_count)
  values (p_user_id, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, usage_date) do update
    set request_count = u.request_count + 1
    where u.request_count < p_limit
  returning u.request_count into v_count;
  if v_count is null then
    return -1;
  end if;
  return p_limit - v_count;
end;
$$;

revoke all on function public.use_teacher_ai_request(uuid, integer) from public, anon, authenticated;
grant execute on function public.use_teacher_ai_request(uuid, integer) to service_role;
