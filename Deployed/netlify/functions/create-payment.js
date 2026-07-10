// ============================================================
//  netlify/functions/create-payment.js
//  Creates a Xendit Invoice (TEST MODE) for an existing order and
//  saves the reference back onto that order row.
//
//  Why this must be a function and not client-side code:
//  the Xendit *secret* key has to sign this request, and that key
//  must never be shipped to the browser — this is the one place
//  it's used, same pattern as reset-pin.js using the Supabase
//  service_role key.
//
//  SECURITY NOTE: the amount charged is always read back from the
//  `orders` table, never taken from the request body. A client could
//  otherwise submit a real order total but request a payment for ₱1.
//
//  Env vars required (Netlify site settings → Environment variables):
//    SUPABASE_URL
//    SUPABASE_SERVICE_ROLE_KEY   (service_role — secret, server-only)
//    XENDIT_SECRET_KEY           (TEST secret key from the Xendit
//                                 dashboard — starts with "xnd_development_"
//                                 while you're in test mode. NEVER the
//                                 "xnd_production_" key during development.)
//    SITE_URL                    (e.g. https://ninapicks.netlify.app —
//                                 used to build the redirect URLs Xendit
//                                 sends the customer back to. Falls back
//                                 to Netlify's own URL/DEPLOY_URL if unset.)
// ============================================================
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;
const SITE_URL = process.env.SITE_URL || process.env.URL || process.env.DEPLOY_URL;

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { success: false, error: 'Method not allowed' });
  }
  if (!XENDIT_SECRET_KEY) {
    console.error('create-payment: XENDIT_SECRET_KEY is not set');
    return json(500, { success: false, error: 'Payment gateway is not configured' });
  }
  // Fail loudly (rather than silently hitting live Xendit) if someone
  // accidentally pastes a production key into this dev/test setup.
  if (XENDIT_SECRET_KEY.startsWith('xnd_production_')) {
    console.error('create-payment: refusing to run — a PRODUCTION Xendit key is set, this integration is TEST MODE ONLY');
    return json(500, { success: false, error: 'Refusing to use a live payment key in test mode' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { success: false, error: 'Invalid JSON body' });
  }

  const { orderId, name, phone, email } = body;
  if (!orderId) {
    return json(400, { success: false, error: 'orderId is required' });
  }

  // --- Look up the order and its REAL total — never trust body.amount ---
  const { data: order, error: orderErr } = await supabaseAdmin
    .from('orders')
    .select('order_id, total, customer_name, phone, payment_status, xendit_payment_id, payment_url')
    .eq('order_id', orderId)
    .maybeSingle();

  if (orderErr) {
    console.error('create-payment: order lookup failed', orderId, orderErr);
    return json(500, { success: false, error: 'Could not look up the order' });
  }
  if (!order) {
    return json(404, { success: false, error: 'Order not found' });
  }
  if (order.payment_status === 'Paid') {
    return json(409, { success: false, error: 'This order is already paid' });
  }
  // Already has a live, unexpired invoice — hand back the same link instead
  // of creating a second Xendit invoice for the same order.
  if (order.payment_status === 'Pending Payment' && order.payment_url && order.xendit_payment_id) {
    return json(200, { success: true, paymentUrl: order.payment_url, reused: true });
  }

  const amount = Number(order.total);
  if (!amount || amount <= 0) {
    console.error('create-payment: order has no valid total', orderId, order.total);
    return json(400, { success: false, error: 'Order has no valid amount' });
  }

  // --- Build the Xendit Invoice request ---
  const invoiceDurationSeconds = 24 * 60 * 60; // 24h test-mode link lifetime
  const payload = {
    external_id: order.order_id,       // this is what the webhook uses to find the order again
    amount,
    currency: 'PHP',
    description: `Nina Picks order ${order.order_id}`,
    invoice_duration: invoiceDurationSeconds,
    payer_email: email || undefined,
    customer: {
      given_names: name || order.customer_name || 'Customer',
      mobile_number: phone || order.phone || undefined,
    },
success_redirect_url: `${SITE_URL}/index.html?order=${encodeURIComponent(order.order_id)}&payment=return&status=success`,
    failure_redirect_url: `${SITE_URL}/index.html?order=${encodeURIComponent(order.order_id)}&payment=return&status=cancelled`,
  };

  let xenditRes, xenditBody;
  try {
    xenditRes = await fetch('https://api.xendit.co/v2/invoices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Xendit auth: HTTP Basic with the secret key as the username and
        // an empty password — NOT a bearer token.
        Authorization: 'Basic ' + Buffer.from(`${XENDIT_SECRET_KEY}:`).toString('base64'),
      },
      body: JSON.stringify(payload),
    });
    xenditBody = await xenditRes.json();
  } catch (err) {
    console.error('create-payment: request to Xendit failed', orderId, err);
    return json(502, { success: false, error: 'Could not reach the payment gateway' });
  }

  if (!xenditRes.ok) {
    console.error('create-payment: Xendit rejected the invoice request', orderId, xenditRes.status, xenditBody);
    return json(502, { success: false, error: xenditBody?.message || 'Payment gateway rejected the request' });
  }

  // --- Save the invoice reference onto the order ---
  const { error: updateErr } = await supabaseAdmin
    .from('orders')
    .update({
      xendit_payment_id: xenditBody.id,
      xendit_reference_id: xenditBody.external_id,
      payment_url: xenditBody.invoice_url,
      payment_provider: 'xendit',
      payment_status: 'Pending Payment',
      payment_expires_at: xenditBody.expiry_date || null,
    })
    .eq('order_id', order.order_id);

  if (updateErr) {
    // The Xendit invoice DID get created at this point — log loudly so it
    // can be reconciled manually, but still hand the link back to the
    // customer since the payment itself is real and usable.
    console.error('create-payment: invoice created but failed to save onto order', orderId, xenditBody.id, updateErr);
  }

  return json(200, { success: true, paymentUrl: xenditBody.invoice_url });
};
