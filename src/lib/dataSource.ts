// The app's two modes, chosen by environment variables (no UI switch):
//
// - Demo Mode: the prototype's mock login and mock data only. Nothing ever
//   contacts Supabase — getSupabase() refuses to create a client — so a demo
//   can't read or change the real database, whatever else is configured.
// - Supabase Mode: real Supabase Auth and database. Each integration is
//   switched on separately (VITE_SUPABASE_INTEGRATIONS, e.g. "auth,classes")
//   so it can be verified on its own; parts not listed keep the mock data.
//
// VITE_APP_MODE=demo|supabase picks the mode. When it's unset, the mode
// follows VITE_SUPABASE_INTEGRATIONS: Supabase Mode if any integration is
// listed, Demo Mode otherwise.

export type AppMode = 'demo' | 'supabase'

export type Integration = 'auth' | 'classes' | 'lessonPlanning' | 'studentFeedback' | 'classFeedback'

const knownIntegrations: readonly Integration[] = ['auth', 'classes', 'lessonPlanning', 'studentFeedback', 'classFeedback']

const listed = new Set(
  (import.meta.env.VITE_SUPABASE_INTEGRATIONS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name): name is Integration => (knownIntegrations as readonly string[]).includes(name)),
)

const requestedMode = import.meta.env.VITE_APP_MODE?.trim().toLowerCase()

export const appMode: AppMode =
  requestedMode === 'demo' || requestedMode === 'supabase' ? requestedMode : listed.size > 0 ? 'supabase' : 'demo'

// The current session's data, decided at login (see AppRoot): 'demo' after
// Explore Demo, 'real' for a signed-in teacher, 'none' before either. A
// demo session never uses Supabase, even in Supabase Mode.
export type SessionDataMode = 'none' | 'demo' | 'real'

let sessionDataMode: SessionDataMode = 'none'

export function setSessionDataMode(mode: SessionDataMode) {
  sessionDataMode = mode
}

export function isDemoSession(): boolean {
  return sessionDataMode === 'demo'
}

export function usesSupabase(integration: Integration): boolean {
  return appMode === 'supabase' && sessionDataMode !== 'demo' && listed.has(integration)
}

// Explore Demo is remembered for this browser tab only (sessionStorage), so
// a refresh stays in the demo while other tabs and new visits start at Login.
const demoSessionKey = 'partners.demoSession'

export function readStoredDemoSession(): boolean {
  try {
    return window.sessionStorage.getItem(demoSessionKey) === '1'
  } catch {
    return false
  }
}

export function storeDemoSession(active: boolean) {
  try {
    if (active) window.sessionStorage.setItem(demoSessionKey, '1')
    else window.sessionStorage.removeItem(demoSessionKey)
  } catch {
    // Storage unavailable: the demo just won't survive a refresh.
  }
}
