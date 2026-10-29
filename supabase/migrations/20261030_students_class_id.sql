-- Each student belongs to exactly one class: students.class_id.
--
-- Student IDs (student_pseudonym) are class-specific, and a student is never
-- matched across classes (the same name in two classes is two students), so
-- the class moves onto the student row. This is step 1 of 3:
--   1. (this migration) add students.class_id from class_enrollments, and point
--      the roster function, the RLS helpers, and the policies that checked
--      enrollment at it. class_enrollments keeps being written and read, so code
--      that still uses it keeps working.
--   2. the app and Edge Functions read students.class_id.
--   3. (later, after checking nothing uses it) drop class_enrollments.
-- No existing row is changed except students gaining their class: Student IDs,
-- submissions, AI conversations, and reports stay as they are.

-- ---------------------------------------------------------------------------
-- students.class_id, from each student's one enrollment
-- ---------------------------------------------------------------------------

alter table public.students add column if not exists class_id uuid;

do $$
begin
  if exists (select 1 from public.class_enrollments group by student_id having count(distinct class_id) > 1) then
    raise exception 'A student is enrolled in more than one class; students.class_id needs exactly one';
  end if;
end;
$$;

update public.students s
set class_id = e.class_id
from public.class_enrollments e
where e.student_id = s.student_id
  and s.class_id is null;

do $$
begin
  if exists (select 1 from public.students where class_id is null) then
    raise exception 'A student has no class enrollment; students.class_id can''t be filled';
  end if;
  if exists (
    select 1 from public.students s join public.class_enrollments e on e.student_id = s.student_id
    where e.class_id <> s.class_id
  ) then
    raise exception 'students.class_id doesn''t match class_enrollments';
  end if;
end;
$$;

alter table public.students alter column class_id set not null;

-- A class with students can't be deleted (their submissions reference them).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_students_class_id' and conrelid = 'public.students'::regclass) then
    alter table public.students add constraint fk_students_class_id foreign key (class_id) references public.classes (class_id);
  end if;
end;
$$;

create index if not exists idx_students_class_id on public.students (class_id);

-- ---------------------------------------------------------------------------
-- RLS helpers: the teacher's students are the students of their classes
-- ---------------------------------------------------------------------------

create or replace function public.teacher_has_student(p_student_id uuid)
returns boolean
language sql
stable security definer
set search_path to ''
as $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.students s
    JOIN public.classes c ON c.class_id = s.class_id
    WHERE s.student_id = p_student_id
      AND c.user_id = (SELECT auth.uid())
  );
$function$;

create or replace function public.teacher_owns_artifact(p_artifact_id uuid)
returns boolean
language sql
stable security definer
set search_path to ''
as $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.student_artifacts a
    JOIN public.student_feedback_pages p
      ON p.feedback_page_id = a.feedback_page_id
    JOIN public.students s
      ON s.student_id = a.student_id
      AND s.class_id = p.class_id
    JOIN public.classes c
      ON c.class_id = p.class_id
    WHERE a.artifact_id = p_artifact_id
      AND c.user_id = (SELECT auth.uid())
      AND p.user_id = (SELECT auth.uid())
  );
$function$;

-- ---------------------------------------------------------------------------
-- Policies that checked enrollment: the student is in the page's class
-- ---------------------------------------------------------------------------

drop policy if exists "Teachers create student artifacts" on public.student_artifacts;
create policy "Teachers create student artifacts" on public.student_artifacts
  as permissive for insert to authenticated
  with check (
    teacher_owns_page(feedback_page_id) AND EXISTS (
      SELECT 1
      FROM public.student_feedback_pages p
      JOIN public.students s ON s.class_id = p.class_id
      WHERE p.feedback_page_id = student_artifacts.feedback_page_id
        AND s.student_id = student_artifacts.student_id
    )
  );

drop policy if exists "Teachers create individual reports" on public.individual_student_reports;
create policy "Teachers create individual reports" on public.individual_student_reports
  as permissive for insert to authenticated
  with check (
    teacher_owns_page(feedback_page_id) AND EXISTS (
      SELECT 1
      FROM public.class_analysis ca
      JOIN public.student_feedback_pages p ON p.feedback_page_id = ca.feedback_page_id
      JOIN public.students s ON s.class_id = p.class_id
      WHERE ca.class_analysis_id = individual_student_reports.class_analysis_id
        AND ca.feedback_page_id = individual_student_reports.feedback_page_id
        AND s.student_id = individual_student_reports.student_id
    )
  );

drop policy if exists "Teachers view individual reports" on public.individual_student_reports;
create policy "Teachers view individual reports" on public.individual_student_reports
  as permissive for select to authenticated
  using (
    teacher_owns_page(feedback_page_id) AND EXISTS (
      SELECT 1
      FROM public.class_analysis ca
      JOIN public.student_feedback_pages p ON p.feedback_page_id = ca.feedback_page_id
      JOIN public.students s ON s.class_id = p.class_id
      WHERE ca.class_analysis_id = individual_student_reports.class_analysis_id
        AND ca.feedback_page_id = individual_student_reports.feedback_page_id
        AND s.student_id = individual_student_reports.student_id
    )
  );

-- ---------------------------------------------------------------------------
-- Roster upload: students are created with their class (and, until step 3,
-- still enrolled); an existing student is found by class and Student ID
-- ---------------------------------------------------------------------------

create or replace function public.register_student_roster(p_class_id uuid, p_students jsonb)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
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
            -- Reuse the student already in this class, if present
            select s.student_id into v_student_id
            from public.students s
            where s.class_id = p_class_id
              and s.student_pseudonym = v_pseudonym
            limit 1;
        end if;

        if v_student_id is null then
            v_pseudonym := public.generate_student_pseudonym();

            insert into public.students (
                student_name,
                student_pseudonym,
                class_id
            )
            values (v_name, v_pseudonym, p_class_id)
            returning student_id into v_student_id;

            -- Kept until class_enrollments is removed (step 3).
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
$function$;

-- save_student_artifact (not used by the app; the Student Feedback Page writes
-- through partners-student-page): the student must be in the page's class.
create or replace function public.save_student_artifact(p_feedback_page_id uuid, p_student_id uuid, p_image_url text, p_explanation_text text, p_submission_event submission_event)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
DECLARE
    v_class_id uuid;
    v_version integer;
    v_artifact_id uuid;
    v_previous_event public.submission_event;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    -- Lock the page to serialize submission numbering
    SELECT class_id INTO v_class_id
    FROM public.student_feedback_pages
    WHERE feedback_page_id = p_feedback_page_id
      AND user_id = auth.uid()
    FOR UPDATE;

    IF v_class_id IS NULL THEN
        RAISE EXCEPTION 'Feedback page access denied';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.students
        WHERE class_id = v_class_id
          AND student_id = p_student_id
    ) THEN
        RAISE EXCEPTION 'Student is not enrolled in this class';
    END IF;

    IF NULLIF(BTRIM(p_image_url), '') IS NULL
       AND NULLIF(BTRIM(p_explanation_text), '') IS NULL
    THEN
        RAISE EXCEPTION 'Artifact content is required';
    END IF;

    SELECT COALESCE(MAX(version_number), 0) + 1
    INTO v_version
    FROM public.student_artifacts
    WHERE feedback_page_id = p_feedback_page_id
      AND student_id = p_student_id;

    IF v_version = 1
       AND p_submission_event IS DISTINCT FROM 'initial'
    THEN
        RAISE EXCEPTION 'First submission must be initial';
    END IF;

    IF v_version > 1
       AND p_submission_event = 'initial'
    THEN
        RAISE EXCEPTION 'Initial submission already exists';
    END IF;

    IF v_version > 1 THEN
        SELECT submission_event INTO v_previous_event
        FROM public.student_artifacts
        WHERE feedback_page_id = p_feedback_page_id
          AND student_id = p_student_id
        ORDER BY version_number DESC
        LIMIT 1;

        IF v_previous_event = 'final' THEN
            RAISE EXCEPTION 'Final submission already recorded';
        END IF;
    END IF;

    INSERT INTO public.student_artifacts (
        student_id,
        feedback_page_id,
        image_url,
        explanation_text,
        version_number,
        submission_event
    )
    VALUES (
        p_student_id,
        p_feedback_page_id,
        NULLIF(BTRIM(p_image_url), ''),
        NULLIF(BTRIM(p_explanation_text), ''),
        v_version,
        p_submission_event
    )
    RETURNING artifact_id INTO v_artifact_id;

    RETURN jsonb_build_object(
        'success', true,
        'artifact_id', v_artifact_id,
        'version_number', v_version,
        'submission_event', p_submission_event
    );
END;
$function$;
