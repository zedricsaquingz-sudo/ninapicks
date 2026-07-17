// ============================================================
//  api/products.js
//  Replaces: getMenu, getMenuList, getMenuByCategory,
//            getCategories, getItemModifiers, updateMenu
// ============================================================
import { supabase } from '../supabase-client.js';
import { getRestaurantByCode } from './restaurants.js';

function slugifyCategory(name) {
  return String(name || '').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'uncategorized';
}

// Full menu with resolved modifiers — used by admin.html (needs everything
// to edit) and the item-detail modal in index.html.
export async function getMenu(restCode) {
  const restaurant = await getRestaurantByCode(restCode);
  if (!restaurant) throw new Error('Restaurant not found');

  const { data, error } = await supabase
    .from('products')
    .select(`*, product_variants (*, variant_modifiers (allowed, modifiers (*)))`)
    .eq('restaurant_id', restaurant.dbId);
  if (error) { console.error('getMenu failed for restaurant', restCode, error); throw error; }

  return data.map(p => ({
    productId: p.product_id, name: p.name, category: p.category,
    basePrice: Number(p.base_price) || 0, description: p.description,
    available: p.available, imageUrl: p.image_url,
    variants: (p.product_variants || []).map(v => ({
      variantId: v.variant_id, variantName: v.variant_name,
      priceAdjustment: Number(v.price_adjustment) || 0, available: v.available,
      modifiers: (v.variant_modifiers || [])
        .filter(vm => vm.allowed)
        .map(vm => ({
          modifierId: vm.modifiers.modifier_id, name: vm.modifiers.name,
          priceAdjustment: Number(vm.modifiers.price_adjustment) || 0,
          type: vm.modifiers.type,
        })),
    })),
  }));
}

// Lightweight version for the customer browse grid — variants included
// (for price-range/pill display) but modifiers deferred to getItemModifiers
// on open, same lazy-load pattern as the old Apps Script getMenuList.
export async function getMenuList(restCode) {
  const restaurant = await getRestaurantByCode(restCode);
  if (!restaurant) throw new Error('Restaurant not found');

  const { data, error } = await supabase
    .from('products')
    .select(`*, product_variants (*, variant_modifiers (allowed))`)
    .eq('restaurant_id', restaurant.dbId);
  if (error) { console.error('getMenuList failed for restaurant', restCode, error); throw error; }

  return data.map(p => ({
    productId: p.product_id, name: p.name, category: p.category,
    basePrice: Number(p.base_price) || 0, description: p.description,
    available: p.available, imageUrl: p.image_url,
    variants: (p.product_variants || []).map(v => ({
      variantId: v.variant_id, variantName: v.variant_name,
      priceAdjustment: Number(v.price_adjustment) || 0, available: v.available,
      hasModifiers: (v.variant_modifiers || []).some(vm => vm.allowed),
    })),
  }));
}

export async function getCategories(restCode) {
  const menu = await getMenuList(restCode);
  const order = [], counts = {}, names = {};
  for (const p of menu) {
    const slug = slugifyCategory(p.category);
    if (counts[slug] === undefined) {
      counts[slug] = 0; names[slug] = p.category || 'Uncategorized'; order.push(slug);
    }
    counts[slug]++;
  }
  return order.map(slug => ({ id: slug, name: names[slug], itemCount: counts[slug] }));
}

export async function getMenuByCategory(restCode, categoryId) {
  const menu = await getMenuList(restCode);
  return menu.filter(p => slugifyCategory(p.category) === categoryId);
}

export async function getItemModifiers(productId) {
  const { data, error } = await supabase
    .from('product_variants')
    .select(`variant_id, variant_modifiers (allowed, modifiers (*))`)
    .eq('product_id', productId);
  if (error) { console.error('getItemModifiers failed for product', productId, error); throw error; }

  const result = {};
  for (const v of data) {
    result[v.variant_id] = (v.variant_modifiers || [])
      .filter(vm => vm.allowed)
      .map(vm => ({
        modifierId: vm.modifiers.modifier_id, name: vm.modifiers.name,
        priceAdjustment: Number(vm.modifiers.price_adjustment) || 0,
        type: vm.modifiers.type,
      }));
  }
  return result;
}

// dashboard.html — "who updated the menu" feed. Reads products once and
// groups by restaurant to find each restaurant's most recent last_updated
// stamp plus how many items changed at that exact moment (matching the
// old Apps Script getMenuActivity's grouping logic, but against a real
// timestamp column instead of a formatted string).
export async function getMenuActivity() {
  const [{ data: products, error }, { data: restaurants }] = await Promise.all([
    supabase.from('products').select('restaurant_id, last_updated'),
    supabase.from('restaurants').select('id, legacy_code, name'),
  ]);
  if (error) { console.error('getMenuActivity failed', error); throw error; }

  const nameLookup = {};
  (restaurants || []).forEach(r => { nameLookup[r.id] = { code: r.legacy_code, name: r.name }; });

  const latest = {}; // restaurant_id → { ts, count }
  for (const p of products) {
    if (!p.last_updated) continue;
    const ts = p.last_updated;
    const bucket = latest[p.restaurant_id];
    if (!bucket || ts > bucket.ts) {
      latest[p.restaurant_id] = { ts, count: 1 };
    } else if (ts === bucket.ts) {
      bucket.count++;
    }
  }

  return Object.keys(latest)
    .map(rid => ({
      restaurantId: nameLookup[rid]?.code || rid,
      restaurantName: nameLookup[rid]?.name || rid,
      lastUpdated: latest[rid].ts,
      itemsChanged: latest[rid].count,
    }))
    .sort((a, b) => (a.lastUpdated < b.lastUpdated ? 1 : a.lastUpdated > b.lastUpdated ? -1 : 0));
}
// Frontend fix: admin.html should only push products the user actually
// touched (compare against the last-loaded values before calling this —
// see the diffing note in admin.html's own migration).
// Backend fix: this now only issues an UPDATE per product that actually
// changed, AND relies on the `set_last_updated_if_changed` trigger
// (nina_picks_supabase_migration.sql) so even if a no-op update slips
// through, last_updated won't move and getMenuActivity won't report a
// phantom change.
export async function updateMenu(restCode, changedProducts) {
  const restaurant = await getRestaurantByCode(restCode);
  if (!restaurant) throw new Error('Restaurant not found');

  let updated = 0;
  for (const upd of changedProducts) {
    const patch = {};
    if (upd.available !== undefined) patch.available = !!upd.available;
    if (upd.price !== undefined) patch.base_price = parseFloat(upd.price);
    if (!Object.keys(patch).length) continue; // nothing to send — skip entirely

    const { error, count } = await supabase
      .from('products')
      .update(patch, { count: 'exact' })
      .eq('product_id', upd.productId)
      .eq('restaurant_id', restaurant.dbId);
    if (!error) updated += count || 0;
    else console.error('updateMenu: failed to update product', upd.productId, error);
  }
  return { rowsUpdated: updated };
}
