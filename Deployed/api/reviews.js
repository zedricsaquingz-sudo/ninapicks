// api/reviews.js
// ─────────────────────────────────────────────────────────────────────────
// New module for the customer reviews feature. It follows the same shape as
// the existing api/restaurants.js, api/products.js, api/orders.js, and
// api/payments.js modules (plain named exports, called from index.html as
// `reviewsApi.getReviewForOrder(...)` / `reviewsApi.submitReview(...)`).
//
import { supabase } from '../supabase-client.js';

/**
 * Look up whether a review already exists for this order.
 * Returns the review row (id, restaurant_id, restaurant_name, order_id,
 * comment, suggestion, created_at) or null if none exists yet.
 */
export async function getReviewForOrder(orderId) {
  if (!orderId) return null;
  const { data, error } = await supabase
    .from('reviews')
    .select('id, restaurant_id, restaurant_name, order_id, comment, suggestion, created_at')
    .eq('order_id', orderId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

/**
 * Submit a new review for a completed order.
 * - restaurantId / restaurantName / orderId are pre-filled by the UI, not
 *   typed by the customer.
 * - Throws Error('already-reviewed') if this order already has a review
 *   (translated from the unique-constraint violation on reviews.order_id,
 *   Postgres error code 23505) so the frontend can show a friendly message
 *   instead of a raw DB error.
 */
export async function submitReview({ restaurantId, restaurantName, orderId, comment, suggestion }) {
  if (!orderId) throw new Error('missing-order-id');
  if (!comment || !comment.trim()) throw new Error('missing-comment');

  const { data, error } = await supabase
    .from('reviews')
    .insert({
      restaurant_id:   restaurantId || null,
      restaurant_name: restaurantName || null,
      order_id:        orderId,
      comment:         comment.trim(),
      suggestion:      (suggestion || '').trim() || null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new Error('already-reviewed');
    throw error;
  }
  return data;
}
