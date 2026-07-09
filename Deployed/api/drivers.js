// ============================================================
//  api/drivers.js
//  Replaces: getDrivers, setDriverAvailability, findDriver,
//            buildDriverLookup
// ============================================================
import { supabase } from '../supabase-client.js';

export async function getDrivers() {
  const { data, error } = await supabase.from('drivers').select('*');
  if (error) { console.error('getDrivers failed', error); throw error; }
  return data.map(d => ({
    id: d.driver_id, name: d.name, phone: d.phone, availability: d.availability,
  }));
}

export async function getDriverByCode(driverId) {
  const { data, error } = await supabase
    .from('drivers').select('*').eq('driver_id', driverId).maybeSingle();
  if (error) { console.error('getDriverByCode failed for', driverId, error); throw error; }
  return data;
}

// Drivers may only set themselves 'Available' / 'Not Available' — the
// third state, 'Currently on Delivery', is only ever set automatically
// (assignDriver / order status triggers), never chosen by the driver.
// RLS enforces that only the signed-in driver can update their own row.
export async function setDriverAvailability(driverId, availability) {
  if (!['Available', 'Not Available'].includes(availability)) {
    throw new Error('Invalid availability value');
  }
  const { data, error } = await supabase
    .from('drivers').update({ availability }).eq('driver_id', driverId).select('driver_id');
  if (error) { console.error('setDriverAvailability failed', { driverId, availability }, error); throw error; }
  if (!data || !data.length) {
    console.error('setDriverAvailability: update matched 0 rows (likely blocked by RLS policy)', { driverId, availability });
    throw new Error('Availability update was rejected by the database (no rows changed) — check RLS policy on `drivers`.');
  }
  return true;
}
