// ============================================================
//  api/restaurants.js
//  Replaces: doGet?action=getRestaurants, setRestaurantStatus
// ============================================================
import { supabase } from '../supabase-client.js';

export async function getRestaurants() {
  const { data, error } = await supabase.from('restaurants').select('*');
  if (error) { console.error('getRestaurants failed', error); throw error; }
  // legacy_code is what index.html/admin.html already treat as "id"
  // (R0001 etc.) — aliased here so no other frontend code has to change.
  // dbId keeps the real bigint PK for internal use (foreign keys, updates).
  return data.map(r => ({ ...r, dbId: r.id, id: r.legacy_code }));
}

export async function getRestaurantByCode(code) {
  const { data, error } = await supabase
    .from('restaurants').select('*').eq('legacy_code', code).maybeSingle();
  if (error) { console.error('getRestaurantByCode failed for code', code, error); throw error; }
  return data ? { ...data, dbId: data.id, id: data.legacy_code } : null;
}

// Only restaurant_admin (their own restaurant) or super_admin can call this
// — enforced by RLS, this function doesn't need its own permission check.
export async function setRestaurantStatus(code, status) {
  if (!['Open', 'Closed'].includes(status)) throw new Error('Invalid status');
  const restaurant = await getRestaurantByCode(code);
  if (!restaurant) throw new Error('Restaurant not found');
  const { data, error } = await supabase
    .from('restaurants').update({ status }).eq('id', restaurant.dbId).select('id');
  if (error) { console.error('setRestaurantStatus failed', { code, status }, error); throw error; }
  // RLS blocks show up as a *silent* 0-row update (error stays null), not
  // a thrown error — so we have to check the returned rows ourselves.
  if (!data || !data.length) {
    console.error('setRestaurantStatus: update matched 0 rows (likely blocked by RLS policy)', { code, status, restaurantDbId: restaurant.dbId });
    throw new Error('Update was rejected by the database (no rows changed) — check RLS policy on `restaurants`.');
  }
  return true;
}
