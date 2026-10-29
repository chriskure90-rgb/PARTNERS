// Supabase Edge Function entry (Deno). All logic is in page.ts.
// Uses the service role (students have no Supabase account); every request
// is scoped by the page's access token and a Student ID on its class roster.
// PARTNERS_PROTOTYPE_WRITES=true turns on writes; STUDENT_SESSION_SECRET
// (32+ random characters) signs the 2-hour student sessions writes require.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { readConfig } from '../partners-generate-lesson/generate.ts'
import { readFeedbackSettings } from './feedback.ts'
import { handleStudentPage, type StudentPageDb } from './page.ts'

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const db: StudentPageDb = {
  findPage: async (accessToken) => {
    const { data, error } = await supabase
      .from('student_feedback_pages')
      .select('feedback_page_id,class_id,lesson_id,lesson_version_id,user_id')
      .eq('access_url', accessToken)
      .maybeSingle()
    if (error) throw error
    return data
  },
  findStudent: async (classId, code) => {
    const { data, error } = await supabase
      .from('students')
      .select('student_id')
      .eq('class_id', classId)
      .eq('student_pseudonym', code)
      .limit(2)
    if (error) throw error
    return data?.length === 1 ? data[0].student_id : null
  },
  loadLesson: async (page) => {
    const { data: lesson, error: lessonError } = await supabase
      .from('lessons')
      .select('lesson_title,grade_level,topic,learning_objectives,science_practices')
      .eq('lesson_id', page.lesson_id)
      .single()
    const { data: version, error: versionError } = await supabase
      .from('lesson_versions')
      .select('lesson_content')
      .eq('lesson_version_id', page.lesson_version_id)
      .eq('lesson_id', page.lesson_id)
      .single()
    if (lessonError || versionError || !lesson || !version) return null
    return {
      title: lesson.lesson_title,
      grade_level: lesson.grade_level,
      topic: lesson.topic,
      content: version.lesson_content,
      learning_objectives: lesson.learning_objectives,
      science_practices: lesson.science_practices,
    }
  },
  recentArtifacts: async (pageId, studentId, limit, workProductId) => {
    const query = supabase
      .from('student_artifacts')
      .select('artifact_id,version_number,submission_event,model_name,explanation_text,image_url,created_at')
      .eq('feedback_page_id', pageId)
      .eq('student_id', studentId)
    const { data, error } = await (workProductId === null ? query.is('work_product_id', null) : query.eq('work_product_id', workProductId))
      .order('version_number', { ascending: false })
      .limit(limit)
    if (error) throw error
    return data ?? []
  },
  insertArtifact: async (row) => {
    const { data, error } = await supabase.from('student_artifacts').insert(row).select('artifact_id,version_number,submission_event').single()
    if (error) {
      if (error.code === '23505') return 'conflict'
      throw error
    }
    return data
  },
  feedbackMessages: async (pageId, studentId) => {
    const { data, error } = await supabase
      .from('student_ai_messages')
      .select('artifact_id,sender_type,message_content,created_at,student_ai_conversations!inner(student_id),student_artifacts!inner(feedback_page_id,version_number,work_product_id)')
      .eq('student_ai_conversations.student_id', studentId)
      .eq('student_artifacts.feedback_page_id', pageId)
      .order('created_at', { ascending: true })
      .limit(1000)
    if (error) throw error
    return (data ?? []).map((m) => ({
      artifact_id: m.artifact_id,
      version_number: (m.student_artifacts as unknown as { version_number: number }).version_number,
      work_product_id: (m.student_artifacts as unknown as { work_product_id: string | null }).work_product_id ?? null,
      sender_type: m.sender_type,
      message_content: m.message_content,
      created_at: m.created_at,
    }))
  },
  conversationFor: async (studentId, artifactId) => {
    const { data, error } = await supabase
      .from('student_ai_conversations')
      .select('conversation_id')
      .eq('student_id', studentId)
      .eq('artifact_id', artifactId)
      .order('created_at', { ascending: true })
      .limit(1)
    if (error) throw error
    return data?.[0]?.conversation_id ?? null
  },
  startConversation: async (studentId, artifactId) => {
    const { data, error } = await supabase
      .from('student_ai_conversations')
      .insert({ student_id: studentId, artifact_id: artifactId })
      .select('conversation_id')
      .single()
    if (error) throw error
    return data.conversation_id
  },
  addMessage: async (conversationId, artifactId, message) => {
    const { error } = await supabase.from('student_ai_messages').insert({ conversation_id: conversationId, artifact_id: artifactId, ...message })
    if (error) throw error
  },
  createUploadUrl: async (path) => {
    const { data, error } = await supabase.storage.from('student_artifacts').createSignedUploadUrl(path)
    if (error || !data) throw error ?? new Error('No upload URL')
    return { signedUrl: data.signedUrl, token: data.token }
  },
  isEnrolled: async (classId, studentId) => {
    const { data, error } = await supabase
      .from('students')
      .select('student_id')
      .eq('class_id', classId)
      .eq('student_id', studentId)
      .maybeSingle()
    if (error) throw error
    return Boolean(data)
  },
  countFailedSignIns: async (pageId, clientKey, sinceIso) => {
    let query = supabase
      .from('student_login_attempts')
      .select('attempt_id', { count: 'exact', head: true })
      .eq('feedback_page_id', pageId)
      .gte('attempted_at', sinceIso)
    if (clientKey) query = query.eq('client_key', clientKey)
    const { count, error } = await query
    if (error) throw error
    return count ?? 0
  },
  recordFailedSignIn: async (pageId, clientKey) => {
    const { error } = await supabase.from('student_login_attempts').insert({ feedback_page_id: pageId, client_key: clientKey })
    if (error) throw error
  },
  imageExists: async (path) => {
    const slash = path.lastIndexOf('/')
    const { data, error } = await supabase.storage
      .from('student_artifacts')
      .list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 1 })
    if (error) throw error
    return Boolean(data?.some((file) => file.name === path.slice(slash + 1)))
  },
  signedImageUrl: async (path) => {
    const { data, error } = await supabase.storage.from('student_artifacts').createSignedUrl(path, 600)
    return error || !data ? null : data.signedUrl
  },
  pruneFailedSignIns: async (beforeIso) => {
    const { error } = await supabase.from('student_login_attempts').delete().lt('attempted_at', beforeIso)
    if (error) throw error
  },
}

// At least 32 characters, or there are no student sessions (and so no writes).
const sessionSecret = Deno.env.get('STUDENT_SESSION_SECRET') ?? ''

// AI feedback: Lesson Generation's switch, key, model, and allowlist (of the
// page's teacher), plus OPENAI_STUDENT_FEEDBACK_MAX_OUTPUT_TOKENS (default
// 800) and OPENAI_STUDENT_FEEDBACK_IMAGES=false for text-only feedback.
const env = (name: string) => Deno.env.get(name)
const ai = { config: readConfig(env), ...readFeedbackSettings(env), fetch }

Deno.serve((req: Request) =>
  handleStudentPage(req, {
    db,
    allowTestWrites: Deno.env.get('PARTNERS_PROTOTYPE_WRITES') === 'true',
    newId: () => crypto.randomUUID(),
    sessionSecret: sessionSecret.length >= 32 ? sessionSecret : null,
    ai,
    log: (message, error) => console.error(message, error),
  }),
)
