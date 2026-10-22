/// <reference types="vite/client" />

interface ImportMetaEnv {
  // 'demo' (mock login and data, never contacts Supabase) or 'supabase'.
  readonly VITE_APP_MODE?: string
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  // Comma-separated integrations that use Supabase (see src/lib/dataSource.ts).
  readonly VITE_SUPABASE_INTEGRATIONS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
