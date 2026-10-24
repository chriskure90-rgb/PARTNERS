-- Student Feedback: secure Student IDs and sign-in rate limiting.
--
-- 1. Student IDs are 8 cryptographically random characters (e.g. K7M9Q4PX)
--    from an unambiguous 31-character alphabet (no 0/O/1/I/L), generated on
--    the server — never chosen by the app — and unique across all classes.
-- 2. Existing students get new IDs; their records, enrollments, and work stay
--    linked (student_id is unchanged).
-- 3. register_student_roster creates the IDs for new students.
-- 4. student_login_attempts records failed sign-ins (hashed client key, page,
--    time) for server-side rate limiting; only the server can reach it.

begin;

-- 1. The generator. gen_random_bytes is pgcrypto's CSPRNG; bytes >= 248 are
-- skipped so every character is equally likely (248 = 31 * 8).
create or replace function public.generate_student_pseudonym()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_id text;
  v_bytes bytea;
  v_byte int;
  i int;
begin
  loop
    v_id := '';
    while length(v_id) < 8 loop
      v_bytes := extensions.gen_random_bytes(16);
      for i in 0 .. 15 loop
        v_byte := get_byte(v_bytes, i);
        if v_byte < 248 and length(v_id) < 8 then
          v_id := v_id || substr(v_alphabet, (v_byte % 31) + 1, 1);
        end if;
      end loop;
    end loop;
    exit when not exists (select 1 from public.students where student_pseudonym = v_id);
  end loop;
  return v_id;
end;
$$;

revoke all on function public.generate_student_pseudonym() from public, anon, authenticated;

comment on function public.generate_student_pseudonym() is 'A new, unused 8-character random Student ID (used by register_student_roster)';

-- 2. New IDs for existing students (anything not already in the new format).
do $$
declare
  r record;
begin
  for r in select student_id from public.students where student_pseudonym !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$' loop
    update public.students set student_pseudonym = public.generate_student_pseudonym() where student_id = r.student_id;
  end loop;
end;
$$;

-- 3. Unique across all classes.
create unique index if not exists uq_students_pseudonym on public.students (student_pseudonym);

-- 4. The roster function: a student already in the class (by their ID) is
-- reused; every new student gets a generated ID — an ID the app sends for a
-- student not in the class is ignored, so IDs are never predictable.
create or replace function public.register_student_roster(p_class_id uuid, p_students jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_student jsonb;
    v_student_id uuid;
    v_name text;
    v_pseudonym text;
    v_results jsonb := '[]'::jsonb;
begin
    if auth.uid() is null or not exists (
        select 1 from public.classes
        where class_id = p_class_id
          and user_id = auth.uid()
    ) then
        raise exception 'Class access denied';
    end if;

    if p_students is null
       or jsonb_typeof(p_students) <> 'array'
       or jsonb_array_length(p_students) = 0
    then
        raise exception 'Invalid student roster';
    end if;

    for v_student in
        select value from jsonb_array_elements(p_students)
    loop
        if jsonb_typeof(v_student) <> 'object' then
            raise exception 'Invalid student entry';
        end if;

        v_name := nullif(btrim(v_student->>'student_name'), '');
        v_pseudonym := nullif(upper(btrim(v_student->>'student_pseudonym')), '');

        if v_name is null then
            raise exception 'Student name required';
        end if;

        v_student_id := null;
        if v_pseudonym is not null then
            -- Reuse the existing entry in this class, if present
            select s.student_id into v_student_id
            from public.students s
            join public.class_enrollments e
              on e.student_id = s.student_id
            where e.class_id = p_class_id
              and s.student_pseudonym = v_pseudonym
            limit 1;
        end if;

        if v_student_id is null then
            v_pseudonym := public.generate_student_pseudonym();

            insert into public.students (
                student_name,
                student_pseudonym
            )
            values (v_name, v_pseudonym)
            returning student_id into v_student_id;

            insert into public.class_enrollments (
                class_id,
                student_id
            )
            values (p_class_id, v_student_id);
        end if;

        v_results := v_results || jsonb_build_array(
            jsonb_build_object(
                'student_id', v_student_id,
                'student_pseudonym', v_pseudonym
            )
        );
    end loop;

    return jsonb_build_object(
        'success', true,
        'students', v_results
    );
end;
$$;

-- 5. Failed sign-ins, for rate limiting (server / service role only).
create table if not exists public.student_login_attempts (
  attempt_id bigint generated always as identity primary key,
  feedback_page_id uuid not null references public.student_feedback_pages (feedback_page_id) on delete cascade,
  client_key text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists idx_student_login_attempts_page_time on public.student_login_attempts (feedback_page_id, attempted_at);

alter table public.student_login_attempts enable row level security;
revoke all on public.student_login_attempts from anon, authenticated;

comment on table public.student_login_attempts is 'Failed Student ID sign-ins (hashed client key, page, time) for rate limiting; server only, no student data';

commit;
