-- Student Feedback, Stage 1: the name a student gives their model, saved with
-- each submission version. Nullable; nothing else changes.
alter table public.student_artifacts
  add column if not exists model_name text;

comment on column public.student_artifacts.model_name is 'Name the student gave their model (Student Feedback Stage 1)';
