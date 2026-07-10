const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const XENDIT_SECRET_KEY = process.env.XENDIT_SECRET_KEY;

const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { success: false, error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { success: false, error: 'Invalid JSON' }); }

  const { orderId } = body;
  if (!orderId) return json(400, { success: false, error: 'orderId is required' });

  const { data: order, error: orderErr } = await supabaseAdmin
    .from('orders')
    .select('order_id, payment_status, xendit_payment_id')
    .eq('order_id', orderId)
    .maybeSingle();

  if (orderErr || !order) return json(404, { success: false, error: 'Order not found' });
  if (order.payment_status === 'Paid') return json(409, { success: false, error: 'Already paid, cannot cancel' });

  if (order.xendit_payment_id) {
    try {
      await fetch(`https://api.xendit.co/invoices/${order.xendit_payment_id}/expire!`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${XENDIT_SECRET_KEY}:`).toString('base64') },
      });
    } catch (err) {
      console.error('cancel-payment: failed to expire Xendit invoice', orderId, err);
    }
  }

  const { error: updateErr } = await supabaseAdmin
    .from('orders')
    .update({ payment_status: 'Cancelled' })
    .eq('order_id', order.order_id);

  if (updateErr) {
    console.error('cancel-payment: failed to update order', orderId, updateErr);
    return json(500, { success: false, error: 'Could not update order' });
  }

  return json(200, { success: true });
};
