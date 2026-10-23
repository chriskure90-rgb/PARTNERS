import { getSupabase } from '../lib/supabase'
import { ApiError, invokeFunction, toApiError } from './core'

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

// ---------------------------------------------------------------------------
// Apply / Dismiss on an AI suggestion, recorded in lesson_revision_actions
// (save_lesson_revision_action) against its lesson_revision_suggestions row.
// ---------------------------------------------------------------------------

export type RevisionActionKind = 'apply' | 'dismiss'

// The suggestion row a saved revision chat belongs to.
export async function revisionSuggestionForConversation(revisionConversationId: string): Promise<string> {
  const { data, error } = await getSupabase()
    .from('lesson_revision_conversations')
    .select('revision_suggestion_id')
    .eq('revision_conversation_id', revisionConversationId)
    .maybeSingle()
  if (error) throw toApiError(error, 'Couldn’t find the revision suggestion.')
  if (!data?.revision_suggestion_id) throw new ApiError('Couldn’t find the revision suggestion.')
  return data.revision_suggestion_id as string
}

// A suggestion row for an AI suggestion acted on without a chat.
export async function saveRevisionSuggestion(input: {
  lessonId: string
  sourceVersionId: string
  targetSection: string
  suggestionContent: string | null
  suggestedChange: string | null
}): Promise<string> {
  const { data, error } = await getSupabase().rpc('save_lesson_revision_suggestion', {
    p_lesson_id: input.lessonId,
    p_source_version_id: input.sourceVersionId,
    p_target_section: input.targetSection,
    p_suggestion_content: input.suggestionContent,
    p_suggested_change: input.suggestedChange,
  })
  if (error) throw toApiError(error, 'Couldn’t save the revision suggestion.')
  const id = (data as { revision_suggestion_id?: string } | null)?.revision_suggestion_id
  if (!id) throw new ApiError('Couldn’t save the revision suggestion.')
  return id
}

export async function saveRevisionAction(revisionSuggestionId: string, action: RevisionActionKind, resultingVersionId: string | null): Promise<void> {
  const { data, error } = await getSupabase().rpc('save_lesson_revision_action', {
    p_revision_suggestion_id: revisionSuggestionId,
    p_teacher_action: action,
    p_resulting_version_id: resultingVersionId,
  })
  if (error) throw toApiError(error, 'Couldn’t record the action.')
  if ((data as { success?: boolean } | null)?.success !== true) throw new ApiError('Couldn’t record the action.')
}
