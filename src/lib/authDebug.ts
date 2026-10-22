// TEMPORARY diagnostics for the Supabase sign-in path (development only).
// Logs step names and a shortened user id — never emails, passwords, or
// tokens. Remove once sign-in is verified against the real project.
export function authDebug(step: string, details: Record<string, string | number | boolean | null> = {}) {
  if (!import.meta.env.DEV) return
  console.info(`[PARTNERS auth] ${step}`, details)
}

// The first 8 characters of a user id — enough to tell sessions apart.
export function shortId(id: string | null | undefined): string | null {
  return id ? id.slice(0, 8) : null
}
