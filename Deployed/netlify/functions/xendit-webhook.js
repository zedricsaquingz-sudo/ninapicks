// ============================================================
//  netlify/functions/xendit-webhook.js
//  Receives server-to-server payment status callbacks from Xendit.
//  This — NOT the customer's browser redirect — is the authoritative
//  source of truth for whether an order got paid.
//
//  Security: Xendit signs webhooks with a static "Verification Token"
//  (set in the Xendit Dashboard → Settings → Webhooks) that it echoes
//  back in the `x-callback-token` header on every call. We compare it
//  against XENDIT_WEBHOOK_TOKEN. This is a shared-secret string
//  compare, not an HMAC — so treat that env var itself as a secret.
//
//  Idempotency: Xendit retries a webhook if it doesn't get a fast 2xx.
//  We insert (provider, event_id) into payment_events with a UNIQUE
//  constraint first; if that insert hits a conflict, we know this
//  exact event was already handled and we skip re-applying it (and
//  skip re-notifying anyone) before returning 200.
//
//  Env vars required:
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY
//    XENDIT_WEBHOOK_TOKEN   (the Verification Token from the Xendit
//                            Dashboard's webhook settings page — NOT
//                            the secret API key)
// ============================================================
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// Fixed-length-independent-ish string compare — not cryptographically
// critical here since this is a static shared token, not an HMAC, but
// there's no reason to use a short-circuiting === on a secret compare.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Xendit Invoice statuses -> our orders.payment_status values.
// PAID and SETTLED both mean "the customer's money arrived" (SETTLED is
// the later "funds disbursed" event for some payment channels) — either
// one should mark the order Paid.
function mapStatus(xenditStatus) {
  switch (xenditStatus) {
    case 'PAID':
    case 'SETTLED':
      return 'Paid';
    case 'EXPIRED':
      return 'Expired';
    case 'PENDING':
      return 'Pending Payment';
    default:
      // Xendit's Invoice product doesn't normally send an explicit
      // "FAILED" status (that's more of an e-wallet/direct-charge
      // concept), but we still want a safe bucket for anything we don't
      // explicitly recognize rather than silently ignoring it.
      return 'Failed';
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { success: false, error: 'Method not allowed' });
  }

  if (!WEBHOOK_TOKEN) {
    console.error('xendit-webhook: XENDIT_WEBHOOK_TOKEN is not configured');
    return json(500, { success: false, error: 'Webhook not configured' });
  }

  const receivedToken = event.headers['x-callback-token'] || event.headers['X-Callback-Token'];
  if (!safeEqual(receivedToken || '', WEBHOOK_TOKEN)) {
    console.warn('xendit-webhook: rejected — bad or missing x-callback-token');
    return json(401, { success: false, error: 'Invalid webhook token' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { success: false, error: 'Invalid JSON body' });
  }

  const { id: invoiceId, external_id: orderId, status, paid_at } = payload;
  if (!invoiceId || !orderId || !status) {
    console.error('xendit-webhook: payload missing id/external_id/status', payload);
    return json(400, { success: false, error: 'Malformed payload' });
  }

  // --- Idempotency guard ---
  const eventId = `${invoiceId}:${status}`;
  const { error: insertErr } = await supabaseAdmin
    .from('payment_events')
    .insert({ provider: 'xendit', event_id: eventId, order_id: orderId, status, raw_payload: payload });

  if (insertErr) {
    if (insertErr.code === '23505') {
      // Unique violation on (provider, event_id) — we've already processed
      // this exact event. Acknowledge and stop, so Xendit stops retrying.
      console.log('xendit-webhook: duplicate event, already processed', eventId);
      return json(200, { success: true, duplicate: true });
    }
    console.error('xendit-webhook: failed to record event', eventId, insertErr);
    return json(500, { success: false, error: 'Failed to record event' });
  }

  // --- Apply the status update ---
  const mappedStatus = mapStatus(status);
  const updatePatch = { payment_status: mappedStatus };
  if (mappedStatus === 'Paid') {
    updatePatch.paid_at = paid_at || new Date().toISOString();
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('orders')
    .update(updatePatch)
    .eq('order_id', orderId)
    .eq('xendit_payment_id', invoiceId) // extra guard: only touch the order this exact invoice belongs to
    .select('order_id');

  if (updateErr) {
    console.error('xendit-webhook: failed to update order', orderId, invoiceId, updateErr);
    return json(500, { success: false, error: 'Failed to update order' });
  }
  if (!updated || !updated.length) {
    console.warn('xendit-webhook: no matching order for this invoice (order_id/xendit_payment_id mismatch)', orderId, invoiceId);
    // Still 200 — this is a data problem to investigate, not something
    // Xendit retrying will fix.
    return json(200, { success: true, warning: 'No matching order' });
  }

  // "Notify restaurant/admin": dashboard.html and admin.html should hold a
  // Supabase Realtime subscription on `orders` (postgres_changes, filtered
  // to payment_status) — same "prefer Realtime over polling" pattern
  // already noted in api/orders.js. No separate notification channel is
  // needed for that; this webhook writing the row is the notification.
  console.log('xendit-webhook: order updated', { orderId, invoiceId, status: mappedStatus });

  return json(200, { success: true });
};
