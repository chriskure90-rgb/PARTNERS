import { getSupabase } from '../lib/supabase'
import { ApiError, requireUserId, toApiError } from './core'

// Class Setup against the deployed tables: users (the teacher's profile),
// classes, and class_enrollments → students. Every request runs as the
// signed-in teacher, so RLS limits it to their own rows; reads also filter
// by user_id explicitly. Rows are returned as stored; App maps them to its
// own types.

export type TeacherProfile = {
  userId: string
  userName: string
  email: string
  state: string
  schoolDistrict: string | null
}

export type ClassRecord = {
  classId: string
  userId: string
  className: string
  gradeLevel: string | null
  period: string | null
  createdAt: string
}

export type RosterStudent = {
  studentId: string
  studentName: string
  // The teacher-defined Student ID students sign in with.
  studentPseudonym: string
  enrolledAt: string
}

type ClassRow = { class_id: string; user_id: string; class_name: string; grade_level: string | null; period: string | null; created_at: string }

const classColumns = 'class_id, user_id, class_name, grade_level, period, created_at'

function toClassRecord(row: ClassRow): ClassRecord {
  return {
    classId: row.class_id,
    userId: row.user_id,
    className: row.class_name,
    gradeLevel: row.grade_level,
    period: row.period,
    createdAt: row.created_at,
  }
}

// The signed-in teacher's profile row, or null if it doesn't exist yet.
export async function getTeacherProfile(): Promise<TeacherProfile | null> {
  const userId = await requireUserId()
  const { data, error } = await getSupabase()
    .from('users')
    .select('user_id, user_name, email, state, school_district')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw toApiError(error, 'Couldn’t load your teacher profile.')
  if (!data) return null
  const row = data as { user_id: string; user_name: string; email: string; state: string; school_district: string | null }
  return { userId: row.user_id, userName: row.user_name, email: row.email, state: row.state, schoolDistrict: row.school_district }
}

// The signed-in teacher's classes, oldest first (the order they were created).
export async function listMyClasses(): Promise<ClassRecord[]> {
  const userId = await requireUserId()
  const { data, error } = await getSupabase().from('classes').select(classColumns).eq('user_id', userId).order('created_at')
  if (error) throw toApiError(error, 'Couldn’t load your classes.')
  return (data as ClassRow[]).map(toClassRecord)
}

// Creates a class owned by the signed-in teacher; the database assigns
// class_id and created_at.
export async function createClass(input: { className: string; gradeLevel: string; period: string }): Promise<ClassRecord> {
  const userId = await requireUserId()
  const className = input.className.trim()
  if (!className) throw new ApiError('Enter a class name.', { code: 'missing_class_name' })
  const { data, error } = await getSupabase()
    .from('classes')
    .insert({
      user_id: userId,
      class_name: className,
      grade_level: input.gradeLevel.trim() || null,
      period: input.period.trim() || null,
    })
    .select(classColumns)
    .single()
  if (error) throw toApiError(error, 'Couldn’t create the class.')
  return toClassRecord(data as ClassRow)
}

// Each class's enrolled students, by class_id (classes with no students
// are absent).
export async function listRosters(classIds: readonly string[]): Promise<Record<string, RosterStudent[]>> {
  if (classIds.length === 0) return {}
  await requireUserId()
  const { data, error } = await getSupabase()
    .from('class_enrollments')
    .select('class_id, created_at, students(student_id, student_name, student_pseudonym)')
    .in('class_id', [...classIds])
    .order('created_at')
  if (error) throw toApiError(error, 'Couldn’t load the class rosters.')
  type EnrollmentRow = {
    class_id: string
    created_at: string
    students: { student_id: string; student_name: string; student_pseudonym: string } | null
  }
  const rosters: Record<string, RosterStudent[]> = {}
  for (const row of data as unknown as EnrollmentRow[]) {
    if (!row.students) continue
    ;(rosters[row.class_id] ??= []).push({
      studentId: row.students.student_id,
      studentName: row.students.student_name,
      studentPseudonym: row.students.student_pseudonym,
      enrolledAt: row.created_at,
    })
  }
  return rosters
}

// Registers students in a class through the existing
// register_student_roster(p_class_id uuid, p_students jsonb) function, which
// writes students and class_enrollments. Each student needs a name and the
// Student ID the app generated for them.
export async function registerStudentRoster(
  classId: string,
  students: readonly { studentName: string; studentPseudonym: string }[],
): Promise<void> {
  if (students.length === 0) return
  await requireUserId()
  const { data, error } = await getSupabase().rpc('register_student_roster', {
    p_class_id: classId,
    p_students: students.map((student) => ({ student_name: student.studentName, student_pseudonym: student.studentPseudonym })),
  })
  if (error) throw toApiError(error, 'Couldn’t add the students.')
  const result = data as { success?: unknown; error?: unknown; message?: unknown } | null
  if (!result || result.success !== true) {
    const message = typeof result?.error === 'string' ? result.error : typeof result?.message === 'string' ? result.message : null
    throw new ApiError(message ?? 'Couldn’t add the students.', { code: 'registration_failed', cause: data })
  }
}
