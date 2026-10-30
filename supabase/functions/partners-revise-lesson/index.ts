// Supabase Edge Function entry (Deno). All logic is in revise.ts.
//
// Uses the same secrets as partners-generate-lesson — LESSON_GENERATION_ENABLED,
// LESSON_GENERATION_ALLOWED_USER_IDS, OPENAI_API_KEY, OPENAI_LESSON_MODEL — plus
//   OPENAI_REVISION_MAX_OUTPUT_TOKENS  default 1000 (200–2000)
// History is written with the teacher's own token, so RLS applies.

import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { readConfig, teacherAiCounter } from '../partners-generate-lesson/generate.ts'
import { handleReviseLesson, readRevisionMaxOutputTokens, type RevisionDb } from './revise.ts'

// Counts teachers' daily AI requests (use_teacher_ai_request; service role only).
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const env = (name: string) => Deno.env.get(name)

const asTeacher = (token: string) =>
  createClient(env('SUPABASE_URL')!, env('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })

const revisionDb = (token: string): RevisionDb => {
  const supabase = asTeacher(token)
  return {
    currentVersionId: async (lessonId) => {
      const { data, error } = await supabase
        .from('lesson_versions')
        .select('lesson_version_id')
        .eq('lesson_id', lessonId)
        .eq('is_current_version', true)
        .maybeSingle()
      if (error) throw error
      return data?.lesson_version_id ?? null
    },
    saveSuggestion: async (input) => {
      // The same suggestion already saved for this lesson and section (by the
      // AI Review, or an earlier Apply/Dismiss) is reused, not saved again.
      // Compared trimmed, as save_lesson_revision_suggestion stores them.
      if (input.suggestionContent?.trim()) {
        const { data: found } = await supabase
          .from('lesson_revision_suggestions')
          .select('revision_suggestion_id')
          .eq('lesson_id', input.lessonId)
          .eq('target_section', input.targetSection.trim())
          .eq('suggestion_content', input.suggestionContent.trim())
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (found?.revision_suggestion_id) return found.revision_suggestion_id as string
      }
      const { data, error } = await supabase.rpc('save_lesson_revision_suggestion', {
        p_lesson_id: input.lessonId,
        p_source_version_id: input.sourceVersionId,
        p_target_section: input.targetSection,
        p_suggestion_content: input.suggestionContent,
        p_suggested_change: input.suggestedChange,
      })
      if (error || data?.success !== true) throw error ?? new Error('Suggestion not saved')
      return data.revision_suggestion_id as string
    },
    startConversation: async (revisionSuggestionId, first) => {
      const { data, error } = await supabase.rpc('save_lesson_revision_conversation', {
        p_revision_suggestion_id: revisionSuggestionId,
        p_messages: [first],
      })
      if (error || data?.success !== true) throw error ?? new Error('Conversation not saved')
      return data.revision_conversation_id as string
    },
    addMessage: async (revisionConversationId, message) => {
      const { error } = await supabase.from('lesson_revision_messages').insert({ revision_conversation_id: revisionConversationId, ...message })
      if (error) throw error
    },
  }
}

Deno.serve((request) =>
  handleReviseLesson(request, {
    config: readConfig(env),
    maxOutputTokens: readRevisionMaxOutputTokens(env),
    authenticate: async (token) => {
      const { data, error } = await asTeacher(token).auth.getUser(token)
      return error || !data.user ? null : data.user.id
    },
    db: revisionDb,
    useAiRequest: teacherAiCounter((fn, args) => admin.rpc(fn, args)),
    fetch,
    // Usage and errors only — never lesson content or the API key.
    log: (event, details) => console.log(JSON.stringify({ event, ...details })),
  }),
)
