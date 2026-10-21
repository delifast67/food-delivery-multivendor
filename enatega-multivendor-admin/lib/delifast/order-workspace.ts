import type { Order } from './client';

/** These are UI affordances only; the server remains the authorization boundary. */
export function orderTransitions(order: Order): string[] {
  if (order.paymentStatus !== 'PAID') return [];
  const next: Record<string, string[]> = {
    CONFIRMED: ['ACCEPTED', 'CANCELLED'],
    ACCEPTED: ['PREPARING', 'CANCELLED'],
    PREPARING: ['READY'],
    READY: ['PICKED_UP'],
    PICKED_UP: ['DELIVERED'],
  };
  return next[order.status] ?? [];
}
export function canAssignRider(order: Order) {
  return order.paymentStatus === 'PAID' && !order.riderId &&
    ['ACCEPTED', 'PREPARING', 'READY'].includes(order.status);
}
export function filterOrders(orders: Order[], filters: {
  status: string; restaurant: string; payment: string; search: string;
}) {
  const search = filters.search.trim().toLocaleLowerCase('fr-FR');
  return orders.filter(order =>
    (filters.status === 'ALL' || order.status === filters.status) &&
    (filters.restaurant === 'ALL' || order.restaurantId === filters.restaurant) &&
    (filters.payment === 'ALL' || order.paymentStatus === filters.payment) &&
    (!search || [order.id, order.deliveryAddress.recipientName].some(value =>
      value.toLocaleLowerCase('fr-FR').includes(search)))
  );
}
