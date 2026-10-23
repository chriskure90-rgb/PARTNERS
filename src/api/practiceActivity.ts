import { getSupabase } from '../lib/supabase'
import { ApiError, invokeFunction, toApiError } from './core'

// Science Practice Activity: a real AI draft through the
// partners-generate-activity Edge Function (one call, never retried here),
// and the Student Feedback Page for a saved activity version
// (create_student_feedback_page). The activity itself is saved like a lesson
// (saveNewLesson / saveLessonVersion in lessonPlanning.ts).

export type ActivityDraftInput = { grade: string; topic: string; phenomenon: string; practices: string[]; teacherMessages: string[] }

export type GeneratedActivity = {
  title: string
  description: string
  goal: string
  sequence: { name: string; text: string }[]
  supports: string
  modelSubmission: string
  explanationSubmission: string
  incorporated: string[]
}

export async function generateActivityDraft(input: ActivityDraftInput): Promise<GeneratedActivity> {
  const result = await invokeFunction<{ success?: boolean; output?: GeneratedActivity }>('partners-generate-activity', input)
  if (result?.success !== true || !result.output) throw new ApiError('The AI service returned no activity.', { code: 'invalid_output' })
  return result.output
}

// The Student Feedback Page's access token (access_url) for a lesson version:
// the existing page for that version, or a new one.
export async function studentFeedbackPageFor(lessonId: string, lessonVersionId: string): Promise<string> {
  const supabase = getSupabase()
  const { data: existing, error: findError } = await supabase
    .from('student_feedback_pages')
    .select('access_url')
    .eq('lesson_id', lessonId)
    .eq('lesson_version_id', lessonVersionId)
    .order('created_at', { ascending: true })
    .limit(1)
  if (findError) throw toApiError(findError, 'Couldn’t look up the Student Feedback Page.')
  if (existing?.[0]?.access_url) return existing[0].access_url as string
  const { data, error } = await supabase.rpc('create_student_feedback_page', { p_lesson_id: lessonId, p_lesson_version_id: lessonVersionId })
  if (error) throw toApiError(error, 'Couldn’t create the Student Feedback Page.')
  const accessUrl = (data as { success?: boolean; access_url?: string } | null)?.access_url
  if (!accessUrl) throw new ApiError('Couldn’t create the Student Feedback Page.')
  return accessUrl
}
