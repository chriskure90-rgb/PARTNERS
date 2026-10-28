import type { Session } from '@supabase/supabase-js'
import { getSupabase } from '../lib/supabase'
import { ApiError, toApiError } from './core'

// Teacher authentication through Supabase Auth. Uses the existing auth users
// and RLS policies; the teacher's profile row (users.user_id = auth user id)
// is read and written by the classes / lessonPlanning modules, not here.

export type TeacherSession = { userId: string; email: string }

function toTeacherSession(session: Session | null): TeacherSession | null {
  const user = session?.user
  return user ? { userId: user.id, email: (user.email ?? '').toLowerCase() } : null
}

export async function signInTeacher(email: string, password: string): Promise<TeacherSession> {
  if (!email.trim() || !password) throw new ApiError('Enter your email and password.', { code: 'missing_credentials' })
  const { data, error } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password })
  if (error) {
    throw toApiError(error, 'Couldn’t log in. Please try again.')
  }
  const session = toTeacherSession(data.session)
  if (!session) throw new ApiError('Couldn’t log in. Please try again.')
  return session
}

// What a new teacher enters on Create Account. The profile details travel
// with the auth account (user metadata) until the teacher's profile row is
// created on their first sign-in (see ensureTeacherProfile).
export type TeacherSignUp = { email: string; password: string; name: string; state: string; district: string }

// Creates the teacher's Supabase Auth account. Returns their session, or null
// when Supabase needs them to confirm their email before signing in.
export async function signUpTeacher(input: TeacherSignUp): Promise<TeacherSession | null> {
  const email = input.email.trim()
  if (!email || !input.password) throw new ApiError('Enter your email and password.', { code: 'missing_credentials' })
  const { data, error } = await getSupabase().auth.signUp({
    email,
    password: input.password,
    options: {
      data: { user_name: input.name.trim(), state: input.state, school_district: input.district.trim() },
      // The confirmation link comes back to this app.
      emailRedirectTo: window.location.origin,
    },
  })
  if (error) throw toApiError(error, 'Couldn’t create your account. Please try again.')
  // With email confirmation on, Supabase answers an already-registered email
  // with a user that has no identities (and sends no email).
  if (data.user && data.user.identities?.length === 0) {
    throw new ApiError('An account with this email already exists. Log in instead.', { code: 'email_taken' })
  }
  return toTeacherSession(data.session)
}

export async function signOutTeacher(): Promise<void> {
  const { error } = await getSupabase().auth.signOut()
  if (error) throw toApiError(error)
}

// The current session, restored from the browser on page load.
export async function getTeacherSession(): Promise<TeacherSession | null> {
  const { data, error } = await getSupabase().auth.getSession()
  if (error) throw toApiError(error)
  return toTeacherSession(data.session)
}

// Calls back on sign-in, sign-out, and token refresh; returns an unsubscribe.
export function onTeacherSessionChange(callback: (session: TeacherSession | null) => void): () => void {
  const { data } = getSupabase().auth.onAuthStateChange((_event, session) => callback(toTeacherSession(session)))
  return () => data.subscription.unsubscribe()
}
