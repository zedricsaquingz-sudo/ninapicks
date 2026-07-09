// ============================================================
//  supabase-client.js
//  Single shared Supabase client — every page (index.html,
//  admin.html, driver.html, dashboard.html) imports this same
//  instance instead of creating its own.
//
//  This uses the PUBLIC anon key on purpose: authorization is
//  enforced by Row Level Security policies in Postgres, not by
//  hiding a secret key in browser JS. Never put the service_role
//  key here — that one only belongs server-side (Netlify function
//  env vars), for things like the future Xendit webhook handler.
// ============================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://oqnzjuisiausoguuusaf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7E97HADepXpTuSJYMJ9qDg_-z_i5xmu';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
