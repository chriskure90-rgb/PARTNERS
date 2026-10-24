import { getSupabase } from '../lib/supabase'
import { ApiError, invokeFunction, toApiError } from './core'

// Class Feedback for a teacher's saved lesson, through the
// partners-class-feedback Edge Function: statistics from the students'
// submissions, the AI class summary linked to the student work behind each
// finding, Suggested Next Steps and Facilitation Questions from it, and an AI
// discussion of each finding (saved per finding); and Individual Student
// Reports for one student at a time.

export type ClassFinding = {
  id: string
  objectiveIndex: number
  practices: string[]
  summary: string
  nextStep?: string
  // The student work (artifact ids) behind the finding.
  artifactIds: string[]
}

export type ClassEvidence = {
  studentName: string
  studentId: string
  // The student’s class Student ID, for opening their Individual Student Report.
  studentCode: string | null
  versionNumber: number
  submissionEvent: 'initial' | 'revised' | 'final'
  modelName: string | null
  explanation: string | null
  // A short-lived link to view the model image.
  imageUrl: string | null
}

export type ClassFeedbackData = {
  feedbackPageId: string
  context: { title: string; topic: string; gradeLevel: string; assignmentPrompt: { product: string; prompt: string }[]; objectives: string[]; practices: string[] }
  statistics: { enrolled: number; studentsSubmitted: number; averageVersions: number | null; resubmissions: number; finalSubmissions: number; aiFeedbackRequests: number }
  // studentsWithNewWork: students who submitted since the summary (0: up to date).
  summary: { generatedAt: string; sampleSize: number; overlap: ClassFinding[]; areasForImprovement: ClassFinding[]; studentsWithNewWork: number } | null
  evidence: Record<string, ClassEvidence>
  questions: { category: 'Whole-class prompts' | 'Peer-to-peer discussion' | 'Debrief'; text: string }[]
  // Each finding's saved discussion, oldest first.
  discussions: Record<string, { sender: 'teacher' | 'ai'; text: string }[]>
  // The AI summary and discussion are available for this teacher.
  aiAvailable: boolean
}

type ClassFeedbackResponse = Omit<ClassFeedbackData, 'feedbackPageId' | 'aiAvailable'> & { success?: boolean; feedback_page_id: string; ai_available: boolean }

const callClassFeedback = <T>(body: Record<string, unknown>) => invokeFunction<T>('partners-class-feedback', body)

function readClassFeedback(result: ClassFeedbackResponse | null): ClassFeedbackData {
  if (result?.success !== true) throw new ApiError('Class Feedback couldn’t be loaded.')
  const { feedback_page_id: feedbackPageId, ai_available: aiAvailable, context, statistics, summary, evidence, questions, discussions } = result
  return { feedbackPageId, aiAvailable, context, statistics, summary, evidence, questions, discussions }
}

// The lesson's newest Student Feedback Page (null: none yet).
export async function latestFeedbackPageId(lessonId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from('student_feedback_pages')
    .select('feedback_page_id')
    .eq('lesson_id', lessonId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw toApiError(error, 'Couldn’t look up the Student Feedback Page.')
  return (data?.[0]?.feedback_page_id as string | undefined) ?? null
}

export async function loadClassFeedback(feedbackPageId: string): Promise<ClassFeedbackData> {
  return readClassFeedback(await callClassFeedback<ClassFeedbackResponse>({ action: 'load_class', feedback_page_id: feedbackPageId }))
}

// Generates the class summary, next steps, and questions, or updates them
// after newer submissions.
export async function generateClassSummary(feedbackPageId: string): Promise<ClassFeedbackData> {
  return readClassFeedback(await callClassFeedback<ClassFeedbackResponse>({ action: 'generate_summary', feedback_page_id: feedbackPageId }))
}

// Asks the AI about one finding and its student work; the server saves both.
export async function discussFinding(feedbackPageId: string, findingId: string, message: string): Promise<{ reply: string }> {
  const result = await callClassFeedback<{ success?: boolean; reply?: string }>({ action: 'discuss', feedback_page_id: feedbackPageId, finding_id: findingId, message })
  if (result?.success !== true || !result.reply) throw new ApiError('The AI couldn’t respond.')
  return { reply: result.reply }
}

// New Facilitation Questions from the saved class summary (2 per category);
// the summary, evidence, next steps, and discussions are unchanged.
export async function regenerateFacilitationQuestions(feedbackPageId: string): Promise<ClassFeedbackData['questions']> {
  const result = await callClassFeedback<{ success?: boolean; questions?: ClassFeedbackData['questions'] }>({
    action: 'regenerate_questions',
    feedback_page_id: feedbackPageId,
  })
  if (result?.success !== true || !Array.isArray(result.questions)) throw new ApiError('New questions couldn’t be generated.')
  return result.questions
}

// ---------------------------------------------------------------------------
// Individual Student Reports (same Edge Function)
// ---------------------------------------------------------------------------

export type StudentReportData = {
  analyzedVersion: number
  generatedAt: string
  overlap: Record<number, string>
  areasForImprovement: Record<number, string>
  revisionChanges: Record<number, string[]>
  nextSteps: { objectiveIndex: number; focus: 'model' | 'explanation'; title: string; action: string }[]
}

export type StudentReportPage = {
  feedbackPageId: string
  context: ClassFeedbackData['context']
  // The work products the teacher confirmed for the assignment.
  products: { model: boolean; explanation: boolean }
  students: { studentId: string; name: string; studentCode: string | null; versions: number; latestEvent: string }[]
  aiAvailable: boolean
  student: {
    studentId: string
    name: string
    studentCode: string | null
    versions: {
      versionNumber: number
      submissionEvent: 'initial' | 'revised' | 'final'
      submittedAt: string
      modelName: string | null
      explanation: string | null
      imageUrl: string | null
    }[]
    // The student's AI feedback conversation for each version.
    conversations: Record<number, { sender: 'student' | 'ai'; text: string }[]>
    report: StudentReportData | null
  } | null
}

type StudentReportResponse = Omit<StudentReportPage, 'feedbackPageId' | 'aiAvailable'> & { success?: boolean; feedback_page_id: string; ai_available: boolean }

function readStudentReportPage(result: StudentReportResponse | null): StudentReportPage {
  if (result?.success !== true) throw new ApiError('Individual Student Reports couldn’t be loaded.')
  const { feedback_page_id: feedbackPageId, ai_available: aiAvailable, context, products, students, student } = result
  return { feedbackPageId, aiAvailable, context, products, students, student }
}

// The students who submitted and, with a student, their versions, AI
// feedback conversations, and saved report.
export async function loadStudentReport(feedbackPageId: string, studentId: string | null): Promise<StudentReportPage> {
  return readStudentReportPage(
    await callClassFeedback<StudentReportResponse>({ action: 'load_student_report', feedback_page_id: feedbackPageId, ...(studentId ? { student_id: studentId } : {}) }),
  )
}

// Generates one student's report, or updates it after newer submissions.
export async function generateStudentReport(feedbackPageId: string, studentId: string): Promise<StudentReportPage> {
  return readStudentReportPage(await callClassFeedback<StudentReportResponse>({ action: 'generate_student_report', feedback_page_id: feedbackPageId, student_id: studentId }))
}
