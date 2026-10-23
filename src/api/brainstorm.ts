import { getSupabase } from '../lib/supabase'
import { ApiError, invokeFunction, toApiError } from './core'

// Brainstorm with AI: real chat replies through the partners-brainstorm Edge
// Function (one call per message, never retried here), and saving the
// conversation to the existing lesson_generation_conversations /
// lesson_generation_messages tables once Generate has saved its lesson.

export type BrainstormRequest = {
  focus: 'lesson' | 'practice'
  message: string
  history: { role: 'teacher' | 'ai'; text: string }[]
  lesson: { topic: string; objectives: string; sequence: string; practices: string }
  noticed: string[]
  stillOpen: string[]
  activity?: { grade: string; topic: string; phenomenon: string; practices: string[]; hasDraft: boolean }
}

export async function brainstormReplyFromAi(request: BrainstormRequest): Promise<string> {
  const result = await invokeFunction<{ success?: boolean; reply?: string }>('partners-brainstorm', request)
  if (result?.success !== true || typeof result.reply !== 'string' || !result.reply.trim()) {
    throw new ApiError('The AI service returned no reply.', { code: 'invalid_output' })
  }
  return result.reply
}

export type BrainstormMessage = { sender_type: 'teacher' | 'ai'; message_content: string }

// Saves a brainstorm conversation for the lesson version Generate produced.
// The conversation is created with its first message
// (save_lesson_generation_conversation); each later message is its own
// insert, so every message gets its own created_at and the order is kept.
export async function saveBrainstormConversation(lessonId: string, resultingVersionId: string, messages: readonly BrainstormMessage[]): Promise<void> {
  if (messages.length === 0) return
  const supabase = getSupabase()
  const { data, error } = await supabase.rpc('save_lesson_generation_conversation', {
    p_lesson_id: lessonId,
    p_messages: [messages[0]],
    p_resulting_version_id: resultingVersionId,
  })
  if (error) throw toApiError(error, 'Couldn’t save the brainstorm conversation.')
  const conversationId = (data as { success?: boolean; generation_conversation_id?: string } | null)?.generation_conversation_id
  if (!conversationId) throw new ApiError('Couldn’t save the brainstorm conversation.')
  for (const message of messages.slice(1)) {
    const { error: insertError } = await supabase.from('lesson_generation_messages').insert({ generation_conversation_id: conversationId, ...message })
    if (insertError) throw toApiError(insertError, 'Couldn’t save the whole brainstorm conversation.')
  }
}
