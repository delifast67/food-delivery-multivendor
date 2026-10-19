/* global describe */
describe('Delifast local admin', () => {
  const snapshot = { data: { me: { id: 'a1', name: 'Admin', role: 'ADMIN', restaurantId: null }, operationsOrders: [{ id: 'order-1', status: 'CONFIRMED', paymentStatus: 'PAID', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z', restaurantId: 'r1', riderId: null, deliveryAddress: { recipientName: 'Client', phone: '70000000', city: 'Ouaga', neighborhood: 'Centre', landmark: 'Marché', instructions: '' }, history: [{ status: 'CONFIRMED', at: '2025-01-01T00:00:00.000Z', actorRole: 'SYSTEM' }], checkout: { currency: 'XOF', subtotal: 1000, deliveryFee: 100, serviceFee: 0, tax: 0, discount: 0, total: 1100, items: [{ menuItemId: 'm1', name: 'Plat', quantity: 1, unitPrice: 1000, total: 1000 }] } }], operationsRestaurants: [{ id: 'r1', name: 'Centre', description: '', open: true, version: 3 }], availableRiders: [] } };
  it('logs in through staffLogin, filters and clears the session', () => {
    cy.intercept('POST', '/api/delifast/graphql', (req) => {
      if (req.body.query.includes('staffLogin')) req.reply({ data: { staffLogin: { token: 'local-token-123456789012345', user: snapshot.data.me } } });
      else if (req.body.query.includes('mutation Logout')) req.reply({ data: { staffLogout: true } });
      else req.reply(snapshot);
    });
    cy.visit('/delifast');
    cy.get('input[type=email]').type('admin@example.test');
    cy.get('input[type=password]').type('not-created-here');
    cy.contains('Se connecter').click();
    cy.contains('Opérations').should('be.visible');
    cy.contains('#order-1').click();
    cy.contains('Historique').should('be.visible');
    cy.contains('Effacer les données / quitter').click();
    cy.contains('Connexion staff existante').should('be.visible');
  });
});
