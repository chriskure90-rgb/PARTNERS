// Supabase Edge Function entry (Deno). All logic is in generate.ts.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   LESSON_GENERATION_ENABLED       "true" to allow paid OpenAI calls (off otherwise)
//   LESSON_GENERATION_ALLOWED_USER_IDS  comma-separated Supabase Auth user ids allowed to
//                                   generate (empty: nobody) — the authorized test account
//   OPENAI_API_KEY                  server-side only — never a VITE_ variable
//   OPENAI_LESSON_MODEL             default "gpt-6-luna"
//   OPENAI_LESSON_MAX_OUTPUT_TOKENS default 4000 (500–8000)
//   OPENAI_LESSON_REASONING_EFFORT  default "low"; "none" sends no reasoning setting
//   OPENAI_REQUEST_TIMEOUT_MS       default 60000
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by the Edge runtime.

import { createClient } from 'npm:@supabase/supabase-js@2.118.0'
import { handleGenerateLesson, readConfig } from './generate.ts'

Deno.serve((request) =>
  handleGenerateLesson(request, {
    config: readConfig((name) => Deno.env.get(name)),
    authenticate: async (token) => {
      const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const { data, error } = await supabase.auth.getUser(token)
      return error || !data.user ? null : data.user.id
    },
    fetch,
    // Usage and errors only — never lesson content or the API key.
    log: (event, details) => console.log(JSON.stringify({ event, ...details })),
  }),
)
