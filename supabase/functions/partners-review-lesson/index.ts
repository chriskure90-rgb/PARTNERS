// Supabase Edge Function entry (Deno). All logic is in review.ts.
//
// Uses the same secrets as partners-generate-lesson — LESSON_GENERATION_ENABLED,
// LESSON_GENERATION_ALLOWED_USER_IDS, OPENAI_API_KEY, OPENAI_LESSON_MODEL — plus
//   OPENAI_REVIEW_MAX_OUTPUT_TOKENS  default 2000 (500–4000)

import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { readConfig, teacherAiCounter } from '../partners-generate-lesson/generate.ts'
import { handleReviewLesson, readReviewMaxOutputTokens } from './review.ts'

// Counts teachers' daily AI requests (use_teacher_ai_request; service role only).
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const env = (name: string) => Deno.env.get(name)

Deno.serve((request) =>
  handleReviewLesson(request, {
    config: readConfig(env),
    maxOutputTokens: readReviewMaxOutputTokens(env),
    authenticate: async (token) => {
      const supabase = createClient(env('SUPABASE_URL')!, env('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
      const { data, error } = await supabase.auth.getUser(token)
      return error || !data.user ? null : data.user.id
    },
    useAiRequest: teacherAiCounter((fn, args) => admin.rpc(fn, args)),
    fetch,
    // Usage and errors only — never lesson content or the API key.
    log: (event, details) => console.log(JSON.stringify({ event, ...details })),
  }),
)
