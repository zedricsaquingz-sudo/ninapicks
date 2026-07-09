// ============================================================
//  api/auth.js
//  Replaces: RESTAURANT_PINS / DRIVER_PINS / SUPERADMIN_PIN +
//            verifyPin() / verifyDriver() from Apps Script.
//
//  Why: hardcoded PIN dictionaries in source code can't be rotated,
//  audited, or scoped per-user, and every "who is this?" check had
//  to re-implement the same lookup. Supabase Auth + `profiles`
//  gives every restaurant/driver/dashboard user a real account,
//  with role/restaurant_id/driver_id resolved once via RLS-safe
//  queries — and leaves room for OTP/MFA/SSO later without
//  touching this module's public API.
// ============================================================
import { supabase } from '../supabase-client.js';

// Restaurants/drivers are provisioned as auth users under a synthetic
// email built from their legacy code, e.g. r0001@ninapicks.internal /
// d001@ninapicks.internal — this keeps the existing "enter your ID + PIN"
// login screens working unchanged; the PIN just becomes the account
// password. Swap this for real emails later if you add self-serve signup.
function syntheticEmail(code) {
  return `${String(code).toLowerCase()}@ninapicks.internal`;
}

export async function login(code, pin) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: syntheticEmail(code),
    password: pin,
  });
  if (error) { console.error('login failed for code', code, error); return { success: false, error: 'Incorrect ID or PIN' }; }
  const profile = await getCurrentProfile();
  return { success: true, session: data.session, profile };
}

export async function logout() {
  await supabase.auth.signOut();
}

export async function getCurrentProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('*, restaurants(legacy_code, name), drivers(driver_id, name, phone, availability)')
    .eq('id', user.id)
    .maybeSingle();
  if (error) { console.error('getCurrentProfile: profiles lookup failed for user', user.id, error); return null; }
  if (!data) console.warn('getCurrentProfile: authenticated but no matching row in `profiles` for user', user.id);
  return data;
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => callback(session));
}
