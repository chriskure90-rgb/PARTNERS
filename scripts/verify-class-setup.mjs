// Checks Class Setup against the real Supabase project with existing test
// teacher accounts — the same queries the app makes, with the publishable
// key and each teacher's own session.
//
//   Read-only (lists teacher A's classes and rosters):
//     TEST_TEACHER_A_EMAIL=… TEST_TEACHER_A_PASSWORD=… node scripts/verify-class-setup.mjs
//   Also create one class as teacher A ("PARTNERS check <time>") with one test
//   student (XP-001) through register_student_roster; there's no
//   delete in the app yet, so remove it in the dashboard afterwards):
//     … node scripts/verify-class-setup.mjs --write
//   Also check isolation: add TEST_TEACHER_B_EMAIL / TEST_TEACHER_B_PASSWORD.
//
// Credentials come only from the environment; nothing is saved or printed.
import { createClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'

const fileEnv = existsSync('.env.local')
  ? Object.fromEntries(
      readFileSync('.env.local', 'utf8')
        .split(/\r?\n/)
        .filter((line) => /^\s*[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
    )
  : {}
const env = (name) => process.env[name] || fileEnv[name] || ''
const url = env('VITE_SUPABASE_URL')
const key = env('VITE_SUPABASE_PUBLISHABLE_KEY')
if (!url || !key) throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.')
if (key.startsWith('sb_secret_')) throw new Error('Use the publishable key, not a secret key.')
const write = process.argv.includes('--write')

let failures = 0
const check = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`)
  if (!condition) failures++
}

async function signIn(prefix) {
  const email = process.env[`${prefix}_EMAIL`]
  const password = process.env[`${prefix}_PASSWORD`]
  if (!email || !password) return null
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`${prefix}: ${error.message}`)
  return { client, userId: data.user.id, label: prefix.endsWith('A') ? 'Teacher A' : 'Teacher B' }
}

async function listClasses({ client, userId }) {
  const { data, error } = await client
    .from('classes')
    .select('class_id, user_id, class_name, grade_level, period, created_at')
    .eq('user_id', userId)
    .order('created_at')
  if (error) throw new Error(`classes: ${error.message}`)
  return data
}

const a = await signIn('TEST_TEACHER_A')
if (!a) throw new Error('Set TEST_TEACHER_A_EMAIL and TEST_TEACHER_A_PASSWORD in the environment.')

const { data: profile, error: profileError } = await a.client.from('users').select('user_id, user_name, state').eq('user_id', a.userId).maybeSingle()
check(!profileError && profile?.user_id === a.userId, `Teacher A has a users profile row${profileError ? ` (${profileError.message})` : ''}`)

let classes = await listClasses(a)
check(classes.every((row) => row.user_id === a.userId), `Teacher A sees ${classes.length} class(es), all their own`)
const { data: unfiltered, error: unfilteredError } = await a.client.from('classes').select('class_id, user_id')
check(!unfilteredError && unfiltered.every((row) => row.user_id === a.userId), 'RLS: an unfiltered query still returns only Teacher A’s classes')

if (classes.length > 0) {
  const { data: enrollments, error } = await a.client
    .from('class_enrollments')
    .select('class_id, students(student_id, student_name, student_pseudonym)')
    .in('class_id', classes.map((row) => row.class_id))
  check(!error, `roster query works${error ? ` (${error.message})` : ''}`)
  if (!error) {
    const withStudent = enrollments.filter((row) => row.students)
    check(withStudent.every((row) => row.students.student_pseudonym), `${enrollments.length} enrollment(s); every enrolled student has a Student ID`)
  }
}

let created = null
if (write) {
  const name = `PARTNERS check ${new Date().toISOString().slice(0, 16)}`
  const { data, error } = await a.client
    .from('classes')
    .insert({ user_id: a.userId, class_name: name, grade_level: '9', period: 'Test' })
    .select('class_id, user_id, class_name, grade_level, period, created_at')
    .single()
  check(!error && data?.user_id === a.userId && Boolean(data?.class_id), `Teacher A created "${name}"${error ? ` (${error.message})` : ''}`)
  created = data
  if (created) {
    classes = await listClasses(a)
    check(classes.some((row) => row.class_id === created.class_id), 'the new class is retrieved')
    // One test student through register_student_roster, as the app does.
    const { data: registered, error: rpcError } = await a.client.rpc('register_student_roster', {
      p_class_id: created.class_id,
      p_students: [{ student_name: 'Test Student', student_pseudonym: 'XP-001' }],
    })
    check(!rpcError && registered?.success === true, `register_student_roster added a test student${rpcError ? ` (${rpcError.message})` : ''}`)
    const { data: roster } = await a.client
      .from('class_enrollments')
      .select('students(student_name, student_pseudonym)')
      .eq('class_id', created.class_id)
    check((roster ?? []).some((row) => row.students?.student_pseudonym === 'XP-001'), 'the registered student is on the roster with Student ID XP-001')
  }
}

const b = await signIn('TEST_TEACHER_B')
if (b) {
  const target = created ?? classes[0]
  const bClasses = await listClasses(b)
  check(bClasses.every((row) => row.user_id === b.userId), `Teacher B sees ${bClasses.length} class(es), all their own`)
  if (target) {
    const { data, error } = await b.client.from('classes').select('class_id').eq('class_id', target.class_id)
    check(!error && data.length === 0, 'Teacher B cannot read Teacher A’s class by its class_id')
    const { data: roster } = await b.client.from('class_enrollments').select('class_id').eq('class_id', target.class_id)
    check((roster ?? []).length === 0, 'Teacher B cannot read Teacher A’s roster')
  }
  // Write attempts (rejected if RLS / the function's checks are right), so only with --write.
  if (write) {
    const { error: forged } = await b.client.from('classes').insert({ user_id: a.userId, class_name: 'should be rejected' }).select('class_id')
    check(Boolean(forged), `Teacher B cannot create a class owned by Teacher A${forged ? ` (${forged.message})` : ''}`)
    if (target) {
      const { data: intruder, error: intruderError } = await b.client.rpc('register_student_roster', {
        p_class_id: target.class_id,
        p_students: [{ student_name: 'Should Be Rejected', student_pseudonym: 'ZZ-999' }],
      })
      check(Boolean(intruderError) || intruder?.success !== true, 'Teacher B cannot register students in Teacher A’s class')
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.')
process.exit(failures ? 1 : 0)
