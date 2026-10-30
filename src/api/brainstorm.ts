import { getSupabase } from '../lib/supabase'
import { ApiError, invokeFunction, requireUserId, toApiError } from './core'

// Brainstorm with AI: real chat replies through the partners-brainstorm Edge
// Function (one call per message, never retried here), and the conversation,
// saved as it happens in lesson_generation_conversations /
// lesson_generation_messages: one conversation per planning focus, for the
// teacher's class until a lesson or activity is created, then linked to it.
// Teacher-only (RLS): a teacher sees and writes only their own.

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

export type BrainstormFocus = 'lesson' | 'practice'

// Where a conversation belongs: the class being planned for and, once there
// is one, the lesson (or activity).
export type BrainstormPlace = { classId: string; lessonId: string | null; focus: BrainstormFocus }

// Starts a conversation (no messages yet); returns its id.
export async function startBrainstormConversation(place: BrainstormPlace): Promise<string> {
  const userId = await requireUserId()
  const { data, error } = await getSupabase()
    .from('lesson_generation_conversations')
    .insert({ user_id: userId, class_id: place.classId, lesson_id: place.lessonId, brainstorm_focus: place.focus })
    .select('generation_conversation_id')
    .single()
  if (error) throw toApiError(error, 'Couldn’t save the conversation.')
  return (data as { generation_conversation_id: string }).generation_conversation_id
}

// Adds one message (its own row and created_at, so the order is kept).
export async function addBrainstormMessage(conversationId: string, message: BrainstormMessage): Promise<void> {
  const { error } = await getSupabase().from('lesson_generation_messages').insert({ generation_conversation_id: conversationId, ...message })
  if (error) throw toApiError(error, 'Couldn’t save the message.')
}

// Links a conversation to the lesson (or activity) it produced, and that version.
export async function linkBrainstormConversation(conversationId: string, lessonId: string, resultingVersionId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('lesson_generation_conversations')
    .update({ lesson_id: lessonId, resulting_version_id: resultingVersionId })
    .eq('generation_conversation_id', conversationId)
  if (error) throw toApiError(error, 'Couldn’t link the conversation to the lesson.')
}

// The conversation to continue: the teacher's latest one for this focus on the
// saved lesson (one saved before focuses were recorded counts too), or, before
// there's a lesson, for the class. Its messages in order (null: none yet). A
// New Conversation is the latest, so the earlier one stays saved but closed.
export async function loadBrainstormConversation(place: BrainstormPlace): Promise<{ conversationId: string; messages: BrainstormMessage[] } | null> {
  const userId = await requireUserId()
  const supabase = getSupabase()
  const base = supabase.from('lesson_generation_conversations').select('generation_conversation_id, created_at').eq('user_id', userId)
  const { data, error } = await (place.lessonId
    ? base.eq('lesson_id', place.lessonId).or(`brainstorm_focus.eq.${place.focus},brainstorm_focus.is.null`)
    : base.eq('class_id', place.classId).is('lesson_id', null).eq('brainstorm_focus', place.focus)
  ).order('created_at', { ascending: false }).limit(1)
  if (error) throw toApiError(error, 'Couldn’t load the conversation.')
  const ids = ((data ?? []) as { generation_conversation_id: string }[]).map((row) => row.generation_conversation_id)
  if (ids.length === 0) return null
  const { data: messages, error: messageError } = await supabase
    .from('lesson_generation_messages')
    .select('sender_type, message_content, created_at')
    .in('generation_conversation_id', ids)
    .order('created_at')
  if (messageError) throw toApiError(messageError, 'Couldn’t load the conversation.')
  return {
    conversationId: ids[ids.length - 1],
    messages: ((messages ?? []) as BrainstormMessage[]).map(({ sender_type, message_content }) => ({ sender_type, message_content })),
  }
}
