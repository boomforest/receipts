// Supabase client — points at the SAME project as Grail so users have one
// account across both products. Anyone with a Grail account can sign into
// Receipts and (during the launch promo) get a free Deep Read.

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  console.warn('[receipts] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing — auth disabled.')
}

export const supabase = url && key
  ? createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } })
  : null

export const authEnabled = !!supabase
