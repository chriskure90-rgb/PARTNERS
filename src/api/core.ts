import { FunctionsHttpError } from '@supabase/supabase-js'
import { getSupabase } from '../lib/supabase'

// Shared plumbing for the API modules (auth, classes, lessonPlanning,
// studentFeedback, classFeedback). UI components never call Supabase
// directly — they call those modules, which use these helpers.

// One error type for every API call: a message safe to show the teacher,
// plus what went wrong underneath for logs.
export class ApiError extends Error {
  readonly code: string | null
  readonly status: number | null
  readonly cause: unknown

  constructor(message: string, options: { code?: string | null; status?: number | null; cause?: unknown } = {}) {
    super(message)
    this.name = 'ApiError'
    this.code = options.code ?? null
    this.status = options.status ?? null
    this.cause = options.cause
  }
}

// A Supabase / PostgREST / auth error (or anything thrown) as an ApiError.
export function toApiError(error: unknown, fallback = 'Something went wrong. Please try again.'): ApiError {
  if (error instanceof ApiError) return error
  if (error && typeof error === 'object') {
    const { message, code, status } = error as { message?: unknown; code?: unknown; status?: unknown }
    return new ApiError(typeof message === 'string' && message ? message : fallback, {
      code: typeof code === 'string' ? code : null,
      status: typeof status === 'number' ? status : null,
      cause: error,
    })
  }
  return new ApiError(fallback, { cause: error })
}

// The signed-in user's id, or an ApiError when nobody is signed in — every
// table is owned by a teacher, so RLS rejects requests without a session.
export async function requireUserId(): Promise<string> {
  const { data, error } = await getSupabase().auth.getSession()
  if (error) throw toApiError(error)
  const userId = data.session?.user.id
  if (!userId) throw new ApiError('Please log in to continue.', { code: 'not_authenticated', status: 401 })
  return userId
}

// Calls an existing Edge Function with the signed-in user's token (added by
// the client). Errors come back as ApiError with the function's own message
// when it returns one as JSON ({ error } or { message }).
export async function invokeFunction<TResponse>(name: string, body: unknown): Promise<TResponse> {
  const { data, error } = await getSupabase().functions.invoke<TResponse>(name, { body: body as Record<string, unknown> })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      let message: string | null = null
      let code: string | null = null
      try {
        const payload = (await error.context.json()) as { error?: unknown; message?: unknown; code?: unknown }
        const text = payload.error ?? payload.message
        message = typeof text === 'string' ? text : null
        code = typeof payload.code === 'string' ? payload.code : null
      } catch {
        // Not JSON — fall back to the generic message below.
      }
      throw new ApiError(message ?? `${name} failed.`, { code, status: error.context.status, cause: error })
    }
    throw toApiError(error, `${name} failed.`)
  }
  return data as TResponse
}
