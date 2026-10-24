import { getSupabase } from '../lib/supabase'
import { ApiError, invokeFunction } from './core'

// The Student Feedback Page for students, through the partners-student-page
// Edge Function. Students have no Supabase account: each call carries the
// page's access token (from its URL) and, after signing in with their class
// Student ID, a 2-hour signed session. Model images go straight to the
// private student_artifacts bucket with a one-time signed upload URL the
// function issues.

export type StudentPageLesson = { title: string; grade_level: string; topic: string; content: unknown }

type StudentPageBody = { action: string; access_token: string } & Record<string, unknown>

const callStudentPage = <T>(body: StudentPageBody) => invokeFunction<T>('partners-student-page', body)

// The confirmed lesson or activity version the page was created for.
export async function loadStudentPage(accessToken: string): Promise<StudentPageLesson> {
  const result = await callStudentPage<{ success?: boolean; lesson?: StudentPageLesson }>({ action: 'load_page', access_token: accessToken })
  if (result?.success !== true || !result.lesson) throw new ApiError('This Student Feedback link couldn’t be loaded.')
  return result.lesson
}

// A signed-in student's session for one page: sent with every write, valid
// for 2 hours (null when the server has no session secret: viewing only).
export type StudentSession = { session: string | null; expiresAt: string }

// Signs in with a Student ID on the page's class roster: the session, or
// null when the ID isn't on it. Too many failed tries throw (rate limited).
export async function verifyStudentId(accessToken: string, studentId: string): Promise<StudentSession | null> {
  try {
    const result = await callStudentPage<{ success?: boolean; session?: string | null; expires_at?: string }>({
      action: 'verify_student',
      access_token: accessToken,
      student_id: studentId,
    })
    return result?.success === true ? { session: result.session ?? null, expiresAt: result.expires_at ?? '' } : null
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

// Uploads the student's model image; returns its storage path, which the
// first submission (submitWork) saves with the model name and explanation.
export async function uploadModelImage(accessToken: string, session: string, file: File): Promise<string> {
  const target = await callStudentPage<{ success?: boolean; path?: string; token?: string }>({
    action: 'model_upload_url',
    access_token: accessToken,
    session,
    file_type: file.type,
  })
  if (target?.success !== true || !target.path || !target.token) throw new ApiError('Your model couldn’t be uploaded.')
  const { error } = await getSupabase().storage.from('student_artifacts').uploadToSignedUrl(target.path, target.token, file, { contentType: file.type })
  if (error) throw new ApiError('Your model couldn’t be uploaded. Please try again.', { cause: error })
  return target.path
}

// The student's newest submission on the page (null: nothing submitted yet).
export type StudentWork = {
  versionNumber: number
  submissionEvent: 'initial' | 'revised' | 'final'
  modelName: string | null
  explanation: string | null
  // A short-lived link to view their model image.
  imageViewUrl: string | null
  // Their AI feedback conversation so far, oldest first, by version.
  feedback: StudentFeedbackMessage[]
}

export type StudentFeedbackMessage = { versionNumber: number; from: 'student' | 'ai'; text: string }

export async function loadMyWork(accessToken: string, session: string): Promise<StudentWork | null> {
  const result = await callStudentPage<{
    success?: boolean
    work?: { version_number: number; submission_event: StudentWork['submissionEvent']; model_name: string | null; explanation_text: string | null; image_view_url: string | null } | null
    feedback?: { version_number: number; sender_type: 'student' | 'ai'; message_content: string }[]
  }>({ action: 'my_work', access_token: accessToken, session })
  if (result?.success !== true) throw new ApiError('Your work couldn’t be loaded.')
  const work = result.work
  return work
    ? {
        versionNumber: work.version_number,
        submissionEvent: work.submission_event,
        modelName: work.model_name,
        explanation: work.explanation_text,
        imageViewUrl: work.image_view_url,
        feedback: (result.feedback ?? []).map((m) => ({ versionNumber: m.version_number, from: m.sender_type, text: m.message_content })),
      }
    : null
}

// Submits a version of the student's work: the first (initial), a revision
// (revised), or their last (final), with the work products the assignment
// asks for. A revision without a new image or model
// name keeps the previous version's.
export async function submitWork(
  accessToken: string,
  session: string,
  work: { event: StudentWork['submissionEvent']; imagePath?: string; modelName?: string; explanation?: string },
): Promise<{ versionNumber: number }> {
  const result = await callStudentPage<{ success?: boolean; version_number?: number }>({
    action: 'submit_artifact',
    access_token: accessToken,
    session,
    submission_event: work.event,
    ...(work.imagePath ? { image_path: work.imagePath } : {}),
    ...(work.modelName ? { model_name: work.modelName } : {}),
    ...(work.explanation ? { explanation_text: work.explanation } : {}),
  })
  if (result?.success !== true || typeof result.version_number !== 'number') throw new ApiError('Your work couldn’t be submitted.')
  return { versionNumber: result.version_number }
}

// AI feedback on the student's newest version: the first feedback (no
// message) or a reply to their message. The server saves both.
export async function requestAiFeedback(accessToken: string, session: string, message: string | null): Promise<{ reply: string; versionNumber: number }> {
  const result = await callStudentPage<{ success?: boolean; reply?: string; version_number?: number }>({
    action: 'ai_feedback',
    access_token: accessToken,
    session,
    ...(message ? { message } : {}),
  })
  if (result?.success !== true || !result.reply || typeof result.version_number !== 'number') throw new ApiError('The AI couldn’t respond right now.')
  return { reply: result.reply, versionNumber: result.version_number }
}
