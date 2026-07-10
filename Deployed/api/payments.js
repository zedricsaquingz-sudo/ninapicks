// ============================================================
//  api/payments.js
//  Thin client for the /create-payment Netlify Function. No Xendit
//  key ever appears here — that lives only in the function itself.
//  This is a public/unauthenticated call (unlike auth.js's resetPin),
//  since a customer placing an order isn't signed in.
// ============================================================

// Creates (or reuses) a Xendit test-mode invoice for an order and
// returns the checkout URL to redirect the customer to.
export async function createPayment({ orderId, name, phone, email }) {
  try {
    const res = await fetch('/.netlify/functions/create-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, name, phone, email }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) {
      console.error('createPayment failed for order', orderId, body.error);
      return { success: false, error: body.error || 'Could not start payment' };
    }
    return { success: true, paymentUrl: body.paymentUrl };
  } catch (err) {
    console.error('createPayment: network/parse error', orderId, err);
    return { success: false, error: 'Could not reach the server' };
  }
}
// Cancels a pending payment: voids the Xendit invoice (if one exists)
// and marks the order as Cancelled.
export async function cancelPayment(orderId) {
  try {
    const res = await fetch('/.netlify/functions/cancel-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId }),
    });
    const body = await res.json();
    if (!res.ok || !body.success) {
      console.error('cancelPayment failed for order', orderId, body.error);
      return { success: false, error: body.error || 'Could not cancel payment' };
    }
    return { success: true };
  } catch (err) {
    console.error('cancelPayment: network/parse error', orderId, err);
    return { success: false, error: 'Could not reach the server' };
  }
}
