// Supabase Edge Function entry (Deno). All logic is in brainstorm.ts.
//
// Uses the same secrets as partners-generate-lesson — LESSON_GENERATION_ENABLED,
// LESSON_GENERATION_ALLOWED_USER_IDS, OPENAI_API_KEY, OPENAI_LESSON_MODEL — plus
//   OPENAI_BRAINSTORM_MAX_OUTPUT_TOKENS  default 600 (200–1500)

import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { readConfig } from '../partners-generate-lesson/generate.ts'
import { handleBrainstorm, readBrainstormMaxOutputTokens } from './brainstorm.ts'

const env = (name: string) => Deno.env.get(name)

Deno.serve((request) =>
  handleBrainstorm(request, {
    config: readConfig(env),
    maxOutputTokens: readBrainstormMaxOutputTokens(env),
    authenticate: async (token) => {
      const supabase = createClient(env('SUPABASE_URL')!, env('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
      const { data, error } = await supabase.auth.getUser(token)
      return error || !data.user ? null : data.user.id
    },
    fetch,
    // Usage and errors only — never chat content or the API key.
    log: (event, details) => console.log(JSON.stringify({ event, ...details })),
  }),
)
