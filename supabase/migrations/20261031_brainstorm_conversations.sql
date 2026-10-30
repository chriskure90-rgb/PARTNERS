-- Brainstorm with AI conversations are saved as they happen, before a lesson
-- or activity exists: a conversation belongs to the teacher and the class
-- they're planning for, with its focus (a whole lesson or a Science Practice
-- Activity), and is linked to the lesson (and the version it produced) once
-- one is created.
--
-- Additive: lesson_id becomes optional; class_id and brainstorm_focus are new.
-- The four existing conversations keep their lesson, version, and messages,
-- and get their lesson's class. Access stays teacher-only.

alter table public.lesson_generation_conversations alter column lesson_id drop not null;
alter table public.lesson_generation_conversations add column if not exists class_id uuid;
alter table public.lesson_generation_conversations add column if not exists brainstorm_focus text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'fk_lesson_generation_conversations_class_id') then
    alter table public.lesson_generation_conversations
      add constraint fk_lesson_generation_conversations_class_id foreign key (class_id) references public.classes (class_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'lesson_generation_conversations_focus_check') then
    alter table public.lesson_generation_conversations
      add constraint lesson_generation_conversations_focus_check check (brainstorm_focus is null or brainstorm_focus in ('lesson', 'practice'));
  end if;
end;
$$;

-- The existing conversations' class, from their lesson.
update public.lesson_generation_conversations c
set class_id = l.class_id
from public.lessons l
where l.lesson_id = c.lesson_id
  and c.class_id is null;

-- Every conversation belongs to a lesson or (before there is one) a class.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lesson_generation_conversations_owner_check') then
    alter table public.lesson_generation_conversations
      add constraint lesson_generation_conversations_owner_check check (lesson_id is not null or class_id is not null);
  end if;
end;
$$;

-- A teacher's latest conversation for a class and focus, before it has a lesson.
create index if not exists idx_lesson_generation_conversations_unlinked
  on public.lesson_generation_conversations (user_id, class_id, brainstorm_focus, created_at desc)
  where lesson_id is null;

-- Teacher-only, as before: the teacher's own conversations, on their own
-- lesson (in the conversation's class, when it has one) and their own class.
drop policy if exists "Teacher owns generation conversations" on public.lesson_generation_conversations;
create policy "Teacher owns generation conversations" on public.lesson_generation_conversations
  as permissive for all to authenticated
  using (
    user_id = (select auth.uid())
    and (lesson_id is null or exists (
      select 1 from public.lessons l
      where l.lesson_id = lesson_generation_conversations.lesson_id
        and l.user_id = (select auth.uid())
        and (lesson_generation_conversations.class_id is null or l.class_id = lesson_generation_conversations.class_id)
    ))
    and (class_id is null or exists (
      select 1 from public.classes c
      where c.class_id = lesson_generation_conversations.class_id
        and c.user_id = (select auth.uid())
    ))
  )
  with check (
    user_id = (select auth.uid())
    and (lesson_id is null or exists (
      select 1 from public.lessons l
      where l.lesson_id = lesson_generation_conversations.lesson_id
        and l.user_id = (select auth.uid())
        and (lesson_generation_conversations.class_id is null or l.class_id = lesson_generation_conversations.class_id)
    ))
    and (class_id is null or exists (
      select 1 from public.classes c
      where c.class_id = lesson_generation_conversations.class_id
        and c.user_id = (select auth.uid())
    ))
  );
-- lesson_generation_messages keeps its policy: messages only in conversations
-- the teacher can see (their own).
