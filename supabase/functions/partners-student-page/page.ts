// partners-student-page: the Student Feedback Page API for students (no
// Supabase account — the page's access token plus a class Student ID).
//
// Runtime-neutral core (testable under Node); index.ts wires it to Deno and
// a service-role client. Actions:
//   load_page        the confirmed lesson/activity version the page was made for
//   verify_student   the Student ID is on the page's class roster
//   my_work          the signed-in student's newest submission (read only)
//   model_upload_url a one-time signed upload URL for the student's model image
//                    (private student_artifacts bucket, under the teacher's
//                    folder: {teacher}/{page}/{student}/{random}.{ext})
//   submit_artifact  a submission version (initial → revised… → final) with the
//                    work products the teacher confirmed (model: image + name;
//                    explanation: text); a revision without a new image or
//                    model name keeps the previous version's
//   ai_feedback      AI feedback on the student's newest version (feedback.ts):
//                    the first feedback, or a reply to the student's message;
//                    the exchange is saved one message at a time in the
//                    version's student_ai_conversations row
// Student IDs are 8 random characters (register_student_roster). Sign-in is
// rate-limited per device and per page (student_login_attempts) and returns a
// 2-hour signed session; the write actions require that session and take the
// student from it, never from a typed ID. Writes also stay off unless
// PARTNERS_PROTOTYPE_WRITES=true.

import { assignmentContext, maxFeedbackPerDay, requestFeedback, requiredProducts, type FeedbackAi } from './feedback.ts'

export type Page = { feedback_page_id: string; class_id: string; lesson_id: string; lesson_version_id: string; user_id: string }

export type StudentPageDb = {
  findPage: (accessToken: string) => Promise<Page | null>
  // The enrolled student with this Student ID (pseudonym) in the class, if exactly one.
  findStudent: (classId: string, code: string) => Promise<string | null>
  loadLesson: (page: Page) => Promise<{
    title: string
    grade_level: string
    topic: string
    content: unknown
    learning_objectives?: string | null
    science_practices?: string[] | null
  } | null>
  // The student's newest submissions on the page, newest first.
  recentArtifacts: (pageId: string, studentId: string, limit: number) => Promise<Artifact[]>
  // 'conflict' on a duplicate version number.
  insertArtifact: (row: {
    feedback_page_id: string
    student_id: string
    explanation_text: string | null
    image_url: string | null
    model_name: string | null
    version_number: number
    submission_event: string
  }) => Promise<{ artifact_id: string; version_number: number; submission_event: string } | 'conflict'>
  // The student's AI feedback messages on the page, oldest first.
  feedbackMessages: (pageId: string, studentId: string) => Promise<FeedbackMessage[]>
  // The conversation for one submission version, and adding to it (one row
  // per message, so each gets its own created_at and the order is kept).
  conversationFor: (studentId: string, artifactId: string) => Promise<string | null>
  startConversation: (studentId: string, artifactId: string) => Promise<string>
  addMessage: (conversationId: string, artifactId: string, message: { sender_type: 'student' | 'ai'; message_content: string }) => Promise<void>
  // A signed upload URL for a path in the student_artifacts bucket.
  createUploadUrl: (path: string) => Promise<{ signedUrl: string; token: string }>
  // Still on the class roster (a session outlives a roster change otherwise).
  isEnrolled: (classId: string, studentId: string) => Promise<boolean>
  // The uploaded model image exists in the student_artifacts bucket.
  imageExists: (path: string) => Promise<boolean>
  // A short-lived link to view a model image.
  signedImageUrl: (path: string) => Promise<string | null>
  // Failed sign-ins since a time: from one device on the page, and on the page.
  countFailedSignIns: (pageId: string, clientKey: string | null, sinceIso: string) => Promise<number>
  recordFailedSignIn: (pageId: string, clientKey: string) => Promise<void>
  pruneFailedSignIns: (beforeIso: string) => Promise<void>
}

export type Artifact = {
  artifact_id: string
  version_number: number
  submission_event: string
  model_name: string | null
  explanation_text: string | null
  image_url: string | null
  created_at: string
}

export type FeedbackMessage = { artifact_id: string; version_number: number; sender_type: 'student' | 'ai'; message_content: string; created_at: string }

export type StudentPageDependencies = {
  db: StudentPageDb
  allowTestWrites: boolean
  newId: () => string
  // Signs student sessions (STUDENT_SESSION_SECRET); null: no sessions, so no writes.
  sessionSecret: string | null
  // AI feedback (null: not configured on the server).
  ai?: FeedbackAi | null
  now?: () => number
  log?: (message: string, error: unknown) => void
}

// ---------------------------------------------------------------------------
// Sign-in limits and sessions
// ---------------------------------------------------------------------------

const signInWindowMs = 15 * 60 * 1000
const maxFailedSignInsPerDevice = 10
const maxFailedSignInsPerPage = 100
export const sessionLengthMs = 2 * 60 * 60 * 1000

const encoder = new TextEncoder()
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

const hmacKey = (secret: string) => crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])

type Session = { p: string; s: string; e: number }

async function signSession(secret: string, session: Session): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(session)))
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload)))
  return `${payload}.${base64url(signature)}`
}

// The session's student, if the token is genuine, unexpired, and for this page.
async function readSession(secret: string, token: unknown, pageId: string, now: number): Promise<string | null> {
  if (typeof token !== 'string' || token.length > 1000) return null
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra !== undefined) return null
  try {
    const genuine = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64url(signature), encoder.encode(payload))
    if (!genuine) return null
    const session = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Session
    return session.p === pageId && typeof session.s === 'string' && typeof session.e === 'number' && session.e > now ? session.s : null
  } catch {
    return null
  }
}

// A device on the page, as a hash of its IP address (never stored raw).
async function clientKeyFor(req: Request): Promise<string> {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown'
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(ip)))
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Student IDs are typed in any case, with or without spaces or dashes.
export function normalizeStudentCode(code: unknown): string | null {
  if (typeof code !== 'string') return null
  const normalized = code.replace(/[\s-]/g, '').toUpperCase()
  return /^[A-Z0-9_]{4,40}$/.test(normalized) ? normalized : null
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
}

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders })
}

const modelImageTypes: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

// A student's model images live under the page's teacher, the page, and the
// student, so teachers can read them (storage policies) and a student can
// only submit their own.
export function modelImageFolder(page: Page, studentId: string): string {
  return `${page.user_id}/${page.feedback_page_id}/${studentId}/`
}

function isOwnModelImagePath(path: unknown, page: Page, studentId: string): path is string {
  if (typeof path !== 'string') return false
  const folder = modelImageFolder(page, studentId)
  return path.startsWith(folder) && /^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(path.slice(folder.length))
}

// Sign-in: rate-limited; a valid Student ID gets a 2-hour session.
async function verifyStudent(deps: StudentPageDependencies, req: Request, page: Page, code: unknown) {
  const now = deps.now?.() ?? Date.now()
  const since = new Date(now - signInWindowMs).toISOString()
  const clientKey = await clientKeyFor(req)
  const [fromDevice, onPage] = await Promise.all([
    deps.db.countFailedSignIns(page.feedback_page_id, clientKey, since),
    deps.db.countFailedSignIns(page.feedback_page_id, null, since),
  ])
  if (fromDevice >= maxFailedSignInsPerDevice || onPage >= maxFailedSignInsPerPage) {
    return respond({ error: 'Too many sign-in attempts. Please wait a few minutes and try again.', code: 'rate_limited' }, 429)
  }
  const normalized = normalizeStudentCode(code)
  const studentId = normalized ? await deps.db.findStudent(page.class_id, normalized) : null
  if (!studentId) {
    await deps.db.recordFailedSignIn(page.feedback_page_id, clientKey)
    await deps.db.pruneFailedSignIns(new Date(now - 24 * 60 * 60 * 1000).toISOString())
    return respond({ error: 'Invalid feedback page or Student ID' }, 404)
  }
  const expiresAt = now + sessionLengthMs
  const session = deps.sessionSecret ? await signSession(deps.sessionSecret, { p: page.feedback_page_id, s: studentId, e: expiresAt }) : null
  return respond({ success: true, student_id_valid: true, session, expires_at: new Date(expiresAt).toISOString() })
}

// The signed-in student for a write: from the session, still on the roster.
async function sessionStudent(deps: StudentPageDependencies, page: Page, token: unknown): Promise<string | Response> {
  if (!deps.sessionSecret) return respond({ error: 'Student sessions aren’t configured', code: 'not_configured' }, 503)
  const studentId = await readSession(deps.sessionSecret, token, page.feedback_page_id, deps.now?.() ?? Date.now())
  if (!studentId || !(await deps.db.isEnrolled(page.class_id, studentId))) {
    return respond({ error: 'Your session has expired. Please sign in again.', code: 'session_expired' }, 401)
  }
  return studentId
}

async function loadPage(deps: StudentPageDependencies, page: Page) {
  const lesson = await deps.db.loadLesson(page)
  if (!lesson) throw new Error('Could not load lesson')
  return respond({
    success: true,
    feedback_page_id: page.feedback_page_id,
    lesson: { title: lesson.title, grade_level: lesson.grade_level, topic: lesson.topic, content: lesson.content },
  })
}

async function modelUploadUrl(deps: StudentPageDependencies, page: Page, body: Record<string, unknown>) {
  const studentId = await sessionStudent(deps, page, body.session)
  if (studentId instanceof Response) return studentId
  const extension = typeof body.file_type === 'string' ? modelImageTypes[body.file_type] : undefined
  if (!extension) return respond({ error: 'Use a PNG, JPEG, or WebP image' }, 400)
  const path = `${modelImageFolder(page, studentId)}${deps.newId()}.${extension}`
  const { signedUrl, token } = await deps.db.createUploadUrl(path)
  return respond({ success: true, path, token, signed_url: signedUrl })
}

async function submitArtifact(deps: StudentPageDependencies, page: Page, body: Record<string, unknown>) {
  const studentId = await sessionStudent(deps, page, body.session)
  if (studentId instanceof Response) return studentId

  const explanation = body.explanation_text
  const event = body.submission_event
  if (explanation != null && (typeof explanation !== 'string' || explanation.length > 20000)) {
    return respond({ error: 'Invalid explanation_text' }, 400)
  }
  if (typeof event !== 'string' || !['initial', 'revised', 'final'].includes(event)) {
    return respond({ error: 'Invalid submission_event' }, 400)
  }
  // The model image: a path this student was given an upload URL for.
  if (body.image_url != null) return respond({ error: 'Send image_path, not image_url' }, 400)
  if (body.image_path != null && !isOwnModelImagePath(body.image_path, page, studentId)) {
    return respond({ error: 'Invalid image_path' }, 400)
  }
  if (body.image_path != null && !(await deps.db.imageExists(body.image_path as string))) {
    return respond({ error: 'Your model image wasn’t found. Please add it again.', code: 'image_missing' }, 400)
  }
  const modelName = body.model_name
  if (modelName != null && (typeof modelName !== 'string' || modelName.length > 200)) {
    return respond({ error: 'Invalid model_name' }, 400)
  }

  const [latest] = await deps.db.recentArtifacts(page.feedback_page_id, studentId, 1)
  if ((!latest && event !== 'initial') || (latest && event === 'initial') || latest?.submission_event === 'final') {
    return respond({ error: 'Invalid submission sequence' }, 409)
  }

  // Every version (initial, revised, final) must have the work products the
  // teacher confirmed for this page, and only those. A revision without a new
  // model image or name keeps the previous version's.
  const lesson = await deps.db.loadLesson(page)
  if (!lesson) throw new Error('Could not load lesson')
  const required = requiredProducts(lesson.content)
  const imageUrl = required.model ? ((body.image_path as string | undefined) ?? latest?.image_url ?? null) : null
  const name = required.model ? (typeof modelName === 'string' && modelName.trim() ? modelName.trim() : (latest?.model_name ?? null)) : null
  const text = required.explanation && typeof explanation === 'string' && explanation.trim() ? explanation.trim() : null
  const missing =
    required.model && !imageUrl
      ? { error: 'Add your model before submitting.', code: 'model_required' }
      : required.model && !name
        ? { error: 'Name your model before submitting.', code: 'model_name_required' }
        : required.explanation && !text
          ? { error: 'Write your explanation before submitting.', code: 'explanation_required' }
          : null
  if (missing) return respond(missing, 400)

  const artifact = await deps.db.insertArtifact({
    feedback_page_id: page.feedback_page_id,
    student_id: studentId,
    explanation_text: text,
    image_url: imageUrl,
    model_name: name,
    version_number: latest ? latest.version_number + 1 : 1,
    submission_event: event,
  })
  if (artifact === 'conflict') return respond({ error: 'Submission version conflict' }, 409)
  return respond(
    { success: true, artifact_id: artifact.artifact_id, version_number: artifact.version_number, submission_event: artifact.submission_event },
    201,
  )
}

// The signed-in student's newest submission on the page and their AI
// feedback so far (read only), so a returning student continues from there.
async function myWork(deps: StudentPageDependencies, page: Page, body: Record<string, unknown>) {
  const studentId = await sessionStudent(deps, page, body.session)
  if (studentId instanceof Response) return studentId
  const [work] = await deps.db.recentArtifacts(page.feedback_page_id, studentId, 1)
  if (!work) return respond({ success: true, work: null, feedback: [] })
  const messages = await deps.db.feedbackMessages(page.feedback_page_id, studentId)
  return respond({
    success: true,
    work: {
      version_number: work.version_number,
      submission_event: work.submission_event,
      model_name: work.model_name,
      explanation_text: work.explanation_text,
      image_view_url: work.image_url ? await deps.db.signedImageUrl(work.image_url) : null,
      submitted_at: work.created_at,
    },
    feedback: messages.map((m) => ({ version_number: m.version_number, sender_type: m.sender_type, message_content: m.message_content })),
  })
}

// AI feedback on the student's newest version: the first feedback (no
// message, once per version) or a reply to their message. The AI's messages
// are written only here, never sent by the browser. Feedback ends once the
// final version is submitted.
async function aiFeedback(deps: StudentPageDependencies, page: Page, body: Record<string, unknown>) {
  const studentId = await sessionStudent(deps, page, body.session)
  if (studentId instanceof Response) return studentId
  const message = body.message ?? null
  if (message !== null && (typeof message !== 'string' || !message.trim() || message.length > 1000)) {
    return respond({ error: 'Write a message of at most 1000 characters.' }, 400)
  }
  const ai = deps.ai
  if (!ai || !ai.config.enabled || !ai.config.apiKey || !ai.config.allowedUserIds.includes(page.user_id)) {
    return respond({ error: 'AI feedback isn’t turned on for this page yet.', code: 'feedback_unavailable' }, 503)
  }
  const [latest, previous] = await deps.db.recentArtifacts(page.feedback_page_id, studentId, 2)
  if (!latest) return respond({ error: 'Submit your model and explanation first.', code: 'nothing_submitted' }, 409)
  if (latest.submission_event === 'final') return respond({ error: 'Your final version is submitted.', code: 'final_submitted' }, 409)

  const now = deps.now?.() ?? Date.now()
  const messages = await deps.db.feedbackMessages(page.feedback_page_id, studentId)
  const usedToday = messages.filter((m) => m.sender_type === 'ai' && Date.parse(m.created_at) > now - 24 * 60 * 60 * 1000).length
  if (usedToday >= maxFeedbackPerDay) {
    return respond({ error: `You’ve used today’s ${maxFeedbackPerDay} AI feedback replies. Keep revising, and try again tomorrow.`, code: 'feedback_limit' }, 429)
  }
  const current = messages.filter((m) => m.artifact_id === latest.artifact_id)
  if (message === null && current.length > 0) return respond({ error: 'Write a message to the AI.' }, 400)

  const lesson = await deps.db.loadLesson(page)
  if (!lesson) throw new Error('Could not load lesson')
  const imageUrl = ai.imageInput && latest.image_url ? await deps.db.signedImageUrl(latest.image_url) : null
  const result = await requestFeedback(
    ai,
    {
      assignment: assignmentContext(lesson),
      work: {
        version: latest.version_number,
        event: latest.submission_event,
        // "attached" only when the AI actually receives the image.
        modelImage: imageUrl ? 'attached' : latest.image_url ? 'submitted, not shown to you' : 'not submitted',
        modelName: latest.model_name,
        explanation: latest.explanation_text,
      },
      previousVersion: previous ? { modelName: previous.model_name, explanation: previous.explanation_text } : null,
      history: current.slice(-12).map((m) => ({ from: m.sender_type, text: m.message_content })),
      message: message?.trim() ?? null,
      imageUrl,
    },
    (event, details) => deps.log?.(event, details),
  )
  if (!result.ok) return respond({ error: result.error, code: result.code }, result.status)

  // Saved in order: the student's message, then the AI's reply. The reply is
  // still shown if saving fails (saved: false).
  let saved = false
  try {
    const conversationId = (await deps.db.conversationFor(studentId, latest.artifact_id)) ?? (await deps.db.startConversation(studentId, latest.artifact_id))
    if (message !== null) await deps.db.addMessage(conversationId, latest.artifact_id, { sender_type: 'student', message_content: message.trim() })
    await deps.db.addMessage(conversationId, latest.artifact_id, { sender_type: 'ai', message_content: result.reply })
    saved = true
  } catch (error) {
    deps.log?.('Student AI chat not saved:', error)
  }
  return respond({ success: true, reply: result.reply, version_number: latest.version_number, saved, replies_left: maxFeedbackPerDay - usedToday - 1 })
}

export async function handleStudentPage(req: Request, deps: StudentPageDependencies): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return respond({ error: 'Method not allowed' }, 405)
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') return respond({ error: 'Invalid request body' }, 400)
    const token = (body as Record<string, unknown>).access_token
    const page = typeof token === 'string' && /^sf-[a-f0-9]{64}$/.test(token) ? await deps.db.findPage(token) : null
    if (!page) return respond({ error: 'Feedback page not found' }, 404)
    const writesOff = () => respond({ error: 'Prototype writes are disabled' }, 403)
    switch ((body as Record<string, unknown>).action) {
      case 'load_page':
        return await loadPage(deps, page)
      case 'verify_student':
        return await verifyStudent(deps, req, page, (body as Record<string, unknown>).student_id)
      case 'my_work':
        return await myWork(deps, page, body as Record<string, unknown>)
      case 'model_upload_url':
        return deps.allowTestWrites ? await modelUploadUrl(deps, page, body as Record<string, unknown>) : writesOff()
      case 'submit_artifact':
        return deps.allowTestWrites ? await submitArtifact(deps, page, body as Record<string, unknown>) : writesOff()
      case 'ai_feedback':
        return deps.allowTestWrites ? await aiFeedback(deps, page, body as Record<string, unknown>) : writesOff()
      default:
        return respond({ error: 'Unknown action' }, 400)
    }
  } catch (error) {
    deps.log?.('Student Feedback API error:', error)
    return respond({ error: 'Request failed' }, 500)
  }
}
