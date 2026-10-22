import { ApiError, invokeFunction } from './core'

// Revise Lesson chat with the real AI, through the partners-revise-lesson
// Edge Function, which also saves the teacher's message and the AI's
// response to the lesson's revision history (lesson_revision_* tables). One
// call per message — never retried here.

export type RevisionRequest = {
  lessonId: string
  revisionConversationId?: string
  section: { label: string; text: string }
  suggestion?: string
  currentProposal?: string
  history: { role: 'teacher' | 'ai'; text: string }[]
  message: string
  lesson: { title: string; topic: string; gradeLevel: string; sciencePractices: string[]; learningObjectives: string[] }
}

export type RevisionResponse = { reply: string; proposal: string | null; revisionConversationId: string | null; historySaved: boolean }

export async function reviseLessonSection(request: RevisionRequest): Promise<RevisionResponse> {
  const result = await invokeFunction<{ success?: boolean } & Partial<RevisionResponse>>('partners-revise-lesson', request)
  if (result?.success !== true || typeof result.reply !== 'string') {
    throw new ApiError('The AI service returned no response.', { code: 'invalid_output' })
  }
  return {
    reply: result.reply,
    proposal: typeof result.proposal === 'string' && result.proposal ? result.proposal : null,
    revisionConversationId: result.revisionConversationId ?? null,
    historySaved: result.historySaved === true,
  }
}
