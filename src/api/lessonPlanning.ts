import { getSupabase } from '../lib/supabase'
import { ApiError, invokeFunction, requireUserId, toApiError } from './core'

// Lesson Planning against the deployed backend:
// - new lessons:   the partners-save-lesson Edge Function (→ save_new_lesson_full),
//                  which creates the lesson and its version 1;
// - new versions:  the update_lesson_version RPC, which adds a version, makes it
//                  the only current one, and syncs the lesson's fields, atomically;
// - the Library:   direct reads of lessons + their current lesson_versions row.
// Every request runs as the signed-in teacher under RLS.

// The lesson columns kept in sync with the current version (the
// p_lesson_fields keys of update_lesson_version; also the Edge Function's
// optional fields).
export type LessonFields = {
  lesson_title: string
  grade_level: string
  topic: string
  standards: string[] | null
  science_practices: string[] | null
  learning_objectives: string | null
  duration: number | null
  prior_instruction: string | null
  subsequent_instruction: string | null
  instructional_sequence: string | null
  materials_equipment: string | null
  lesson_template_path: string | null
  rubric_path: string | null
  differentiation: string | null
}

export type VersionCreatedBy = 'ai' | 'teacher' | 'ai_teacher'

export type SavedVersion = { lessonId: string; lessonVersionId: string; versionNumber: number }

export type StoredLesson = {
  lessonId: string
  classId: string
  lessonSource: 'generated' | 'uploaded'
  fields: LessonFields
  createdAt: string
  updatedAt: string
  currentVersion: {
    lessonVersionId: string
    versionNumber: number
    content: Record<string, unknown>
    createdBy: VersionCreatedBy
    createdAt: string
  } | null
}

function assertContent(content: Record<string, unknown>) {
  if (!content || typeof content !== 'object' || Array.isArray(content) || Object.keys(content).length === 0) {
    throw new ApiError('The lesson has no content to save.', { code: 'invalid_content' })
  }
}

function savedVersionFrom(data: unknown, fallbackLessonId?: string): SavedVersion {
  const result = data as { success?: unknown; lesson_id?: unknown; lesson_version_id?: unknown; version_number?: unknown } | null
  const lessonId = typeof result?.lesson_id === 'string' ? result.lesson_id : fallbackLessonId
  if (!result || result.success !== true || !lessonId || typeof result.lesson_version_id !== 'string' || typeof result.version_number !== 'number') {
    throw new ApiError('The lesson wasn’t saved — the server didn’t confirm it.', { code: 'not_saved', cause: data })
  }
  return { lessonId, lessonVersionId: result.lesson_version_id, versionNumber: result.version_number }
}

// Creates a lesson for one of the teacher's classes, with its first version.
export async function saveNewLesson(input: {
  classId: string
  lessonSource: 'generated' | 'uploaded'
  fields: LessonFields
  content: Record<string, unknown>
}): Promise<SavedVersion> {
  assertContent(input.content)
  await requireUserId()
  const data = await invokeFunction<unknown>('partners-save-lesson', {
    class_id: input.classId,
    lesson_source: input.lessonSource,
    lesson_content: input.content,
    ...input.fields,
  })
  return savedVersionFrom(data)
}

// Adds a new current version of a lesson and syncs its fields, atomically.
export async function saveLessonVersion(input: {
  lessonId: string
  content: Record<string, unknown>
  createdBy: VersionCreatedBy
  fields: LessonFields
}): Promise<SavedVersion> {
  assertContent(input.content)
  await requireUserId()
  const { data, error } = await getSupabase().rpc('update_lesson_version', {
    p_lesson_id: input.lessonId,
    p_lesson_content: input.content,
    p_created_by: input.createdBy,
    p_lesson_fields: input.fields,
  })
  if (error) throw toApiError(error, 'Couldn’t save the lesson changes.')
  return savedVersionFrom(data, input.lessonId)
}

type LessonRow = {
  lesson_id: string
  class_id: string
  lesson_source: 'generated' | 'uploaded'
  created_at: string
  updated_at: string
} & LessonFields

const lessonColumns =
  'lesson_id, class_id, lesson_source, lesson_title, grade_level, topic, standards, science_practices, learning_objectives, duration, ' +
  'prior_instruction, subsequent_instruction, instructional_sequence, materials_equipment, lesson_template_path, rubric_path, differentiation, created_at, updated_at'

// The signed-in teacher's lessons for the given classes, oldest first, each
// with its current version.
export async function listLessonsForClasses(classIds: readonly string[]): Promise<StoredLesson[]> {
  if (classIds.length === 0) return []
  const userId = await requireUserId()
  const supabase = getSupabase()
  const { data: lessons, error } = await supabase
    .from('lessons')
    .select(lessonColumns)
    .eq('user_id', userId)
    .in('class_id', [...classIds])
    .order('created_at')
  if (error) throw toApiError(error, 'Couldn’t load your lessons.')
  const rows = lessons as unknown as LessonRow[]
  if (rows.length === 0) return []
  const { data: versions, error: versionError } = await supabase
    .from('lesson_versions')
    .select('lesson_version_id, lesson_id, version_number, lesson_content, created_by, created_at')
    .in('lesson_id', rows.map((row) => row.lesson_id))
    .eq('is_current_version', true)
  if (versionError) throw toApiError(versionError, 'Couldn’t load your lessons.')
  type VersionRow = { lesson_version_id: string; lesson_id: string; version_number: number; lesson_content: Record<string, unknown>; created_by: VersionCreatedBy; created_at: string }
  const current = new Map((versions as VersionRow[]).map((version) => [version.lesson_id, version]))
  return rows.map((row) => {
    const version = current.get(row.lesson_id)
    return {
      lessonId: row.lesson_id,
      classId: row.class_id,
      lessonSource: row.lesson_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      fields: {
        lesson_title: row.lesson_title,
        grade_level: row.grade_level,
        topic: row.topic,
        standards: row.standards,
        science_practices: row.science_practices,
        learning_objectives: row.learning_objectives,
        duration: row.duration,
        prior_instruction: row.prior_instruction,
        subsequent_instruction: row.subsequent_instruction,
        instructional_sequence: row.instructional_sequence,
        materials_equipment: row.materials_equipment,
        lesson_template_path: row.lesson_template_path,
        rubric_path: row.rubric_path,
        differentiation: row.differentiation,
      },
      currentVersion: version
        ? {
            lessonVersionId: version.lesson_version_id,
            versionNumber: version.version_number,
            content: version.lesson_content,
            createdBy: version.created_by,
            createdAt: version.created_at,
          }
        : null,
    }
  })
}
