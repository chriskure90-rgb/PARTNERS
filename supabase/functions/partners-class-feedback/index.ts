// Supabase Edge Function entry (Deno). The Class Feedback and Individual
// Student Reports logic is in classFeedback.ts.
//
// Uses the service role, scoped to feedback pages the signed-in teacher owns.
// AI uses partners-generate-lesson's secrets — LESSON_GENERATION_ENABLED,
// LESSON_GENERATION_ALLOWED_USER_IDS, OPENAI_API_KEY, OPENAI_LESSON_MODEL —
// plus, optionally:
//   OPENAI_CLASS_SUMMARY_MAX_OUTPUT_TOKENS  default 6000
//   OPENAI_CLASS_DISCUSS_MAX_OUTPUT_TOKENS  default 1200
//   OPENAI_CLASS_SUMMARY_MAX_IMAGES         default 30 (0: text only)

import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { readConfig, teacherAiCounter } from '../partners-generate-lesson/generate.ts'
import { handleClassFeedback, readClassFeedbackSettings, type ClassDb } from './classFeedback.ts'

const env = (name: string) => Deno.env.get(name)
const db = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!)

async function getAnalysis(feedbackPageId: string) {
  const { data, error } = await db.from('class_analysis').select('*').eq('feedback_page_id', feedbackPageId).limit(2)
  if (error) throw error
  if ((data?.length ?? 0) > 1) throw new Error('Multiple analyses found for feedback page')
  return data?.[0] ?? null
}

// --- Database access ------------------------------------------------------

const classDb: ClassDb = {
  authenticate: async (token) => {
    const { data, error } = await db.auth.getUser(token)
    return error || !data.user ? null : data.user.id
  },
  ownedPage: async (pageId, userId) => {
    const { data, error } = await db
      .from('student_feedback_pages')
      .select('feedback_page_id,class_id,lesson_id,lesson_version_id,user_id')
      .eq('feedback_page_id', pageId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw error
    return data
  },
  loadLesson: async (page) => {
    const [{ data: lesson }, { data: version }] = await Promise.all([
      db.from('lessons').select('lesson_title,grade_level,topic,learning_objectives,science_practices').eq('lesson_id', page.lesson_id).single(),
      db.from('lesson_versions').select('lesson_content').eq('lesson_version_id', page.lesson_version_id).eq('lesson_id', page.lesson_id).single(),
    ])
    if (!lesson || !version) return null
    return {
      title: lesson.lesson_title,
      grade_level: lesson.grade_level,
      topic: lesson.topic,
      learning_objectives: lesson.learning_objectives,
      science_practices: lesson.science_practices,
      content: version.lesson_content,
    }
  },
  enrolledCount: async (classId) => {
    const { count, error } = await db.from('students').select('student_id', { count: 'exact', head: true }).eq('class_id', classId)
    if (error) throw error
    return count ?? 0
  },
  artifacts: async (pageId) => {
    const { data, error } = await db
      .from('student_artifacts')
      .select('artifact_id,student_id,version_number,submission_event,model_name,explanation_text,image_url,created_at,work_product_id,students(student_name,student_pseudonym)')
      .eq('feedback_page_id', pageId)
      .order('created_at', { ascending: true })
      .limit(2000)
    if (error) throw error
    return (data ?? []).map(({ students, ...artifact }) => ({
      ...artifact,
      student_name: (students as unknown as { student_name: string | null } | null)?.student_name ?? null,
      student_code: (students as unknown as { student_pseudonym: string | null } | null)?.student_pseudonym ?? null,
    }))
  },
  aiReplyCount: async (pageId) => {
    const { count, error } = await db
      .from('student_ai_messages')
      .select('message_id,student_artifacts!inner(feedback_page_id)', { count: 'exact', head: true })
      .eq('sender_type', 'ai')
      .eq('student_artifacts.feedback_page_id', pageId)
    if (error) throw error
    return count ?? 0
  },
  analysis: (pageId) => getAnalysis(pageId),
  saveAnalysis: async (pageId, existingId, values) => {
    const query = existingId
      ? db.from('class_analysis').update(values).eq('class_analysis_id', existingId)
      : db.from('class_analysis').insert({ feedback_page_id: pageId, ...values })
    const { data, error } = await query.select('class_analysis_id').single()
    if (error) throw error
    return data.class_analysis_id
  },
  updateFindings: async (analysisId, column, value) => {
    const { error } = await db.from('class_analysis').update({ [column]: value }).eq('class_analysis_id', analysisId)
    if (error) throw error
  },
  replaceQuestions: async (analysisId, questions) => {
    // The new questions are added before the old ones are removed, so a
    // failed save leaves the previous set in place.
    const { data: old, error } = await db.from('facilitation_questions').select('facilitation_question_id').eq('class_analysis_id', analysisId)
    if (error) throw error
    const added: string[] = []
    // One row at a time, so each has its own created_at and the order is kept.
    for (const question of questions) {
      const { data, error: insertError } = await db
        .from('facilitation_questions')
        .insert({ class_analysis_id: analysisId, question_content: question })
        .select('facilitation_question_id')
        .single()
      if (insertError) {
        if (added.length > 0) await db.from('facilitation_questions').delete().in('facilitation_question_id', added)
        throw insertError
      }
      added.push(data.facilitation_question_id)
    }
    const oldIds = (old ?? []).map((row) => row.facilitation_question_id)
    if (oldIds.length > 0) {
      const { error: deleteError } = await db.from('facilitation_questions').delete().in('facilitation_question_id', oldIds)
      if (deleteError) throw deleteError
    }
  },
  questions: async (analysisId) => {
    const { data, error } = await db.from('facilitation_questions').select('question_content').eq('class_analysis_id', analysisId).order('created_at')
    if (error) throw error
    return (data ?? []).map((row) => row.question_content)
  },
  signedImageUrl: async (path, seconds) => {
    const { data, error } = await db.storage.from('student_artifacts').createSignedUrl(path, seconds)
    return error || !data ? null : data.signedUrl
  },
  startConversation: async (analysisId, userId) => {
    const { data, error } = await db
      .from('classfeedback_ai_conversations')
      .insert({ class_analysis_id: analysisId, user_id: userId })
      .select('conversation_id')
      .single()
    if (error) throw error
    return data.conversation_id
  },
  addMessage: async (conversationId, message) => {
    const { error } = await db.from('classfeedback_ai_messages').insert({ conversation_id: conversationId, ...message })
    if (error) throw error
  },
  messages: async (conversationIds) => {
    const { data, error } = await db
      .from('classfeedback_ai_messages')
      .select('conversation_id,sender_type,message_content')
      .in('conversation_id', conversationIds)
      .order('created_at')
    if (error) throw error
    return data ?? []
  },
  createAnalysis: async (pageId, counts) => {
    const { data, error } = await db
      .from('class_analysis')
      .insert({ feedback_page_id: pageId, ...counts, average_time_on_task: null, objective_overlap: null, areas_for_improvement: null })
      .select('class_analysis_id')
      .single()
    if (error) throw error
    return data.class_analysis_id
  },
  studentConversations: async (pageId, studentId) => {
    const { data, error } = await db
      .from('student_ai_messages')
      .select('artifact_id,sender_type,message_content,student_ai_conversations!inner(student_id),student_artifacts!inner(feedback_page_id)')
      .eq('student_ai_conversations.student_id', studentId)
      .eq('student_artifacts.feedback_page_id', pageId)
      .order('created_at', { ascending: true })
      .limit(1000)
    if (error) throw error
    return (data ?? []).map(({ artifact_id, sender_type, message_content }) => ({ artifact_id, sender_type, message_content }))
  },
  studentReport: async (analysisId, studentId) => {
    const { data, error } = await db
      .from('individual_student_reports')
      .select('objective_overlap,areas_for_improvement,revision_change,individual_student_next_step,created_at')
      .eq('class_analysis_id', analysisId)
      .eq('student_id', studentId)
      .maybeSingle()
    if (error) throw error
    return data
  },
  saveStudentReport: async (analysisId, pageId, studentId, values) => {
    // One report per analysis and student (uq_individual_student_reports_analysis_student).
    const { error } = await db
      .from('individual_student_reports')
      .upsert({ class_analysis_id: analysisId, feedback_page_id: pageId, student_id: studentId, ...values }, { onConflict: 'class_analysis_id,student_id' })
    if (error) throw error
  },
}

const settings = readClassFeedbackSettings(env)

Deno.serve((req: Request) =>
  handleClassFeedback(req, {
    db: classDb,
    ai: { config: readConfig(env), ...settings, fetch },
    useAiRequest: teacherAiCounter((fn, args) => db.rpc(fn, args)),
    // Usage and errors only — never student work or the API key.
    log: (event, details) => console.log(JSON.stringify({ event, ...details })),
  }),
)
