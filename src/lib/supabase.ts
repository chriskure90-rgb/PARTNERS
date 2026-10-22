import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { appMode, isDemoSession } from './dataSource'

// The app's one Supabase client, created on first use from the project URL
// and the publishable (anon) key. Only browser-safe keys belong here: data
// access is limited by the signed-in user's Row Level Security policies.
// Service-role / secret keys and OpenAI keys stay on the server (Edge
// Functions) and must never be put in a VITE_ variable.
//
// The client is untyped until `npm run gen:types` has generated
// src/api/databaseTypes.ts from the deployed database; it is then typed as
// createClient<Database>(…).

const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? ''
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''

export const isSupabaseConfigured = Boolean(url && publishableKey)

// A secret key in a browser bundle would bypass every RLS policy, so refuse
// to start with one: new-style secret keys, or a legacy JWT key whose role
// is service_role.
function looksLikeSecretKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true
  const payload = key.split('.')[1]
  if (!payload) return false
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown }
    return claims.role === 'service_role'
  } catch {
    return false
  }
}

let client: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  // Demo Mode and Explore Demo sessions must never reach the real database.
  if (appMode !== 'supabase') {
    throw new Error('Supabase is off in Demo Mode. Set VITE_APP_MODE=supabase to use the real backend.')
  }
  if (isDemoSession()) {
    throw new Error('The demo never uses Supabase.')
  }
  if (!isSupabaseConfigured) {
    throw new Error('Supabase isn’t configured: set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in .env.local.')
  }
  if (looksLikeSecretKey(publishableKey)) {
    throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY is a secret (service-role) key. Use the publishable key — secret keys must never be in frontend code.')
  }
  client ??= createClient(url, publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true },
  })
  return client
}
