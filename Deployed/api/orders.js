// ============================================================
//  api/orders.js
//  Replaces: getOrders, getAllOrders, getOrderStatus,
//            getDriverOrders, getOrderStats, assignDriver,
//            updateOrderStatus, and the order-save section of doPost.
//
//  Order-history inserts and "driver becomes Available on Delivered/
//  Cancelled" are DB triggers (nina_picks_supabase_migration.sql) —
//  not duplicated here, so a status change from ANY page (dashboard,
//  restaurant, driver) behaves identically.
// ============================================================
import { supabase } from '../supabase-client.js';
import { getRestaurantByCode } from './restaurants.js';

const VALID_STATUSES = [
  'Pending', 'Accepted', 'Preparing', 'Ready for Pickup',
  'Picked Up / On the Way', 'Delivered', 'Cancelled',
];
const DRIVER_ALLOWED_STATUSES = ['Picked Up / On the Way', 'Delivered'];

function mapOrderRow(o) {
  return {
    orderId: o.order_id, timestamp: o.timestamp, name: o.customer_name,
    phone: o.phone, location: o.location,
    items: (o.order_items || [])
      .map(i => {
        const base = `${i.quantity}x ${i.products?.name || ''}${i.product_variants ? ' (' + i.product_variants.variant_name + ')' : ''}`;
        const mods = (i.order_item_modifiers || []).map(m => m.modifiers?.name).filter(Boolean);
        return mods.length ? `${base} +${mods.join('+')}` : base;
      })
      .join(', '),
    total: Number(o.total) || 0, status: o.status,
    restaurantId: o.restaurants?.legacy_code, restaurantName: o.restaurants?.name,
    paymentMethod: o.payment_method, notes: o.notes,
    paymentStatus: o.payment_status, paymentReference: o.payment_reference,
    paymentProvider: o.payment_provider, paidAt: o.paid_at,
    driverId: o.drivers?.driver_id || '', driverName: o.drivers?.name || '',
    driverPhone: o.drivers?.phone || '',
  };
}

const ORDER_SELECT = `*, restaurants(legacy_code, name), drivers(driver_id, name, phone),
  order_items(quantity, unit_price, subtotal, products(name), product_variants(variant_name),
    order_item_modifiers(price, modifiers(name)))`;

// admin.html — this restaurant's orders only (RLS also enforces this
// server-side; the .eq() here just avoids fetching rows you can't see).
export async function getOrders(restCode) {
  const restaurant = await getRestaurantByCode(restCode);
  if (!restaurant) throw new Error('Restaurant not found');
  const { data, error } = await supabase
    .from('orders').select(ORDER_SELECT)
    .eq('restaurant_id', restaurant.dbId)
    .order('timestamp', { ascending: false });
  if (error) { console.error('getOrders failed for restaurant', restCode, error); throw error; }
  return data.map(mapOrderRow);
}

// dashboard.html — every order, across every restaurant, in one query
// (replaces the old N-requests-per-restaurant workaround entirely).
export async function getAllOrders({ activeOnly = false } = {}) {
  let query = supabase.from('orders').select(ORDER_SELECT).order('timestamp', { ascending: false });
  if (activeOnly) query = query.not('status', 'in', '("Delivered","Cancelled")');
  const { data, error } = await query;
  if (error) { console.error('getAllOrders failed', error); throw error; }
  return data.map(mapOrderRow);
}

// driver.html — orders assigned to the signed-in driver (RLS-restricted).
// Also returns the driver's current availability, so periodic refreshes
// of this page keep the toggle accurate — the old Apps Script version of
// this endpoint only ever returned {id, name}, so a stale availability
// value could linger after the very first login until a full re-login.
export async function getDriverOrders(driverId) {
  const [{ data, error }, driver] = await Promise.all([
    supabase
      .from('orders').select(`*, restaurants(name, address),
        order_items(quantity, unit_price, subtotal, products(name), product_variants(variant_name),
          order_item_modifiers(price, modifiers(name)))`)
      .eq('driver_id', driverId)
      .order('timestamp', { ascending: false }),
    getDriverForOrders(driverId),
  ]);
  if (error) { console.error('getDriverOrders failed for driver', driverId, error); throw error; }
  return {
    driver,
    orders: data.map(o => ({
      orderId: o.order_id, timestamp: o.timestamp, name: o.customer_name,
      phone: o.phone, location: o.location, total: Number(o.total) || 0,
      status: o.status, restaurantName: o.restaurants?.name,
      restaurantLocation: o.restaurants?.address,
      notes: o.notes,
      items: (o.order_items || [])
        .map(i => {
          const base = `${i.quantity}x ${i.products?.name || ''}${i.product_variants ? ' (' + i.product_variants.variant_name + ')' : ''}`;
          const mods = (i.order_item_modifiers || []).map(m => m.modifiers?.name).filter(Boolean);
          return mods.length ? `${base} +${mods.join('+')}` : base;
        })
        .join(', '),
    })),
  };
}

async function getDriverForOrders(driverId) {
  const { data } = await supabase
    .from('drivers').select('driver_id, name, availability').eq('driver_id', driverId).maybeSingle();
  return data ? { id: data.driver_id, name: data.name, availability: data.availability } : null;
}

// Customer order-tracking page. No caching layer needed anymore — prefer
// a Realtime subscription here instead of polling once the frontend is
// ready to drop the old bustUrl/_t=Date.now() pattern.
export async function getOrderStatus(orderId) {
  const { data, error } = await supabase
    .from('orders').select(`*, restaurants(name), drivers(*)`)
    .eq('order_id', orderId).maybeSingle();
  if (error) { console.error('getOrderStatus failed for order', orderId, error); throw error; }
  if (!data) return null;
  return {
    orderId: data.order_id, status: data.status,
    shop: data.restaurants?.name || '', total: Number(data.total) || 0,
    notes: data.notes || '',
    driver: data.drivers
      ? { id: data.drivers.driver_id, name: data.drivers.name, phone: data.drivers.phone }
      : null,
    // Xendit/payment fields — used by index.html's post-redirect polling
    // (see checkPaymentReturn()) to show Paid/Failed/Expired/Pending.
    paymentMethod: data.payment_method,
    paymentStatus: data.payment_status,
    paymentUrl: data.payment_url,
    paidAt: data.paid_at,
  };
}

export async function getOrderStats() {
  const { data, error } = await supabase.from('orders').select('status, total, timestamp');
  if (error) { console.error('getOrderStats failed', error); throw error; }
  const byStatus = {}; VALID_STATUSES.forEach(s => (byStatus[s] = 0));
  let todayCount = 0, todayValue = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const o of data) {
    byStatus[o.status] = (byStatus[o.status] || 0) + 1;
    if ((o.timestamp || '').slice(0, 10) === today) {
      todayCount++; todayValue += Number(o.total) || 0;
    }
  }
  return { total: data.length, todayCount, todayValue, byStatus };
}

// dashboard.html / admin.html — assign or reassign a driver. Passing a
// falsy driverId (e.g. the "— Unassigned —" option's value="") must become
// SQL NULL, not an empty string — orders.driver_id has a foreign key to
// drivers.driver_id, and '' isn't a valid driver_id, so sending it as-is
// throws "violates foreign key constraint orders_driver_id_fkey".
export async function assignDriver(orderId, driverId) {
  const { data, error } = await supabase
    .from('orders').update({ driver_id: driverId || null }).eq('order_id', orderId).select('order_id');
  if (error) { console.error('assignDriver failed', { orderId, driverId }, error); throw error; }
  if (!data || !data.length) {
    console.error('assignDriver: update matched 0 rows (likely blocked by RLS policy)', { orderId, driverId });
    throw new Error('Assignment was rejected by the database (no rows changed) — check RLS policy on `orders`.');
  }
  return true;
}

// Shared by admin.html (Pending→Picked Up, not Delivered), driver.html
// (Picked Up/Delivered only), and dashboard.html (anything). RLS is the
// real enforcement; this client-side check just fails fast with a clear
// message instead of a raw 403 from Postgres.
export async function updateOrderStatus(orderId, status, { asDriver = false } = {}) {
  if (!VALID_STATUSES.includes(status)) throw new Error('Invalid status: ' + status);
  if (asDriver && !DRIVER_ALLOWED_STATUSES.includes(status)) {
    throw new Error('Drivers can only mark Picked Up or Delivered');
  }
  const { data, error } = await supabase
    .from('orders').update({ status }).eq('order_id', orderId).select('order_id');
  if (error) { console.error('updateOrderStatus failed', { orderId, status }, error); throw error; }
  if (!data || !data.length) {
    console.error('updateOrderStatus: update matched 0 rows (likely blocked by RLS policy)', { orderId, status });
    throw new Error('Status update was rejected by the database (no rows changed) — check RLS policy on `orders`.');
  }
  return true;
}

// index.html — create a new order + its line items/modifiers.
// Replaces the flattened Items/ReadableItems strings with real rows in
// order_items / order_item_modifiers.
//
// IMPORTANT: from the customer's point of view, "did my order go through"
// means "does the parent `orders` row exist" — that's the row admin/driver/
// dashboard all key off of. Line-item and modifier rows are important for
// reporting/receipts, but a hiccup on one of them (a bad product id, a
// missing RLS SELECT policy on order_items, a flaky request) must never
// turn a successfully-placed order into a false "Error sending order" for
// the customer. Each item is therefore its own try/catch: failures are
// logged to the console with enough context to debug, but never thrown
// past this point once the parent order row is confirmed saved.
export async function createOrder(order, orderItems) {
  const restaurant = await getRestaurantByCode(order.shop.id);
  if (!restaurant) throw new Error('Unknown restaurant');

  const { error: orderErr } = await supabase.from('orders').insert({
    order_id: order.orderId, restaurant_id: restaurant.dbId,
    timestamp: order.timestamp, customer_name: order.name, phone: order.phone,
    location: order.location, total: order.total, payment_method: order.paymentMethod,
    notes: order.notes || '', status: order.status || 'Pending',
    // COD / manual GCash: 'Unpaid' (the DB default covers this too, but
    // being explicit here avoids relying on it silently). Xendit orders
    // move to 'Pending Payment' the moment create-payment.js makes the
    // invoice — this is just the pre-payment placeholder.
    payment_status: order.paymentMethod === 'Xendit' ? 'Pending Payment' : 'Unpaid',
  });
  if (orderErr) {
    console.error('createOrder: failed to insert parent order row', orderErr, order);
    throw orderErr; // the order itself didn't save — this one really is fatal
  }

  for (const item of orderItems || []) {
    try {
      const { data: inserted, error: itemErr } = await supabase
        .from('order_items')
        .insert({
          order_id: order.orderId, product_id: item.productId,
          variant_id: item.variantId || null, quantity: item.quantity,
          unit_price: item.unitPrice, subtotal: item.subtotal,
        })
        .select('id').single();

      if (itemErr || !inserted) {
        console.error('createOrder: order_items insert did not return a row (order was still saved) — check that order_items has an anon/authenticated SELECT policy, since .select().single() requires one:', itemErr, item);
        continue;
      }

      if (item.modifiers?.length) {
        const { error: modErr } = await supabase.from('order_item_modifiers').insert(
          item.modifiers.map(m => ({ order_item_id: inserted.id, modifier_id: m.modifierId, price: m.price }))
        );
        if (modErr) console.error('createOrder: order_item_modifiers insert failed (order was still saved):', modErr, item);
      }
    } catch (lineErr) {
      // Any unexpected error on one line item (network blip, bad shape,
      // etc.) — log it and move on to the next item rather than letting
      // it bubble up and report a false failure for an order that saved.
      console.error('createOrder: unexpected error saving a line item (order was still saved):', lineErr, item);
    }
  }

  return { orderId: order.orderId };
}
