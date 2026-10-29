-- One assignment can have several student work products (e.g. a Mechanistic
-- Model and a Systemic Model), each submitted, revised, and given AI feedback
-- on its own. A submission version belongs to one work product: its id from
-- the page's lesson version content. NULL is a submission made before work
-- products (the page's one Model / Explanation assignment) — existing rows
-- stay as they are.

alter table public.student_artifacts add column if not exists work_product_id text;

-- Version numbers count per student, page, and work product (each work
-- product has its own initial → revised… → final).
drop index if exists public.uq_student_artifacts_version;
create unique index uq_student_artifacts_version
  on public.student_artifacts (student_id, feedback_page_id, coalesce(work_product_id, ''), version_number);
