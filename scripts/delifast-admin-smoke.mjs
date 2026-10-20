#!/usr/bin/env node
// MongoDB jetable uniquement. Ne touche ni la base de travail ni un paiement.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');
require('tsx/cjs');
const { DelifastClient } = require('../enatega-multivendor-admin/lib/delifast/client.ts');
const root = fileURLToPath(new URL('../', import.meta.url));
const apiPort = Number(process.env.DELIFAST_ADMIN_API_TEST_PORT || 4113);
const webPort = Number(process.env.DELIFAST_ADMIN_WEB_TEST_PORT || 4114);
const origin = `http://127.0.0.1:${webPort}`;
const children = [];
let mongo, dbClient, env, checks = 0;
const ok = label => console.log(`OK ${++checks} — ${label}`);
function start(args, cwd, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  child.stdout.on('data', x => { child.log += x; });
  child.stderr.on('data', x => { child.log += x; });
  children.push(child);
  return child;
}
async function cli(path) {
  const child = start([path], `${root}delifast-api`);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, child.log);
}
async function ready(url, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(child.log);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Service indisponible : ${url}\n${child.log}`);
}
async function raw(query, variables = {}, token) {
  const response = await fetch(`${origin}/api/delifast/graphql`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000),
  });
  return response.json();
}
async function gql(query, variables = {}, token) {
  const result = await raw(query, variables, token);
  assert.ok(!result.errors, JSON.stringify(result.errors));
  return result.data;
}
async function rejected(query, variables, token, code) {
  const result = await raw(query, variables, token);
  assert.ok(result.errors?.length, 'La requête aurait dû être refusée');
  if (code) assert.equal(result.errors[0].extensions.code, code);
}
const ordersQuery = '{operationsOrders{id status paymentStatus restaurantId riderId accessToken history{status actorRole} checkout{total items{name quantity baseUnitPrice unitPrice selectedOptions{name priceXof}}} deliveryAddress{recipientName}}}';
const restaurantsQuery = '{operationsRestaurants{id name open version}}';
const openMutation = 'mutation($id:ID!,$version:Int!,$open:Boolean!){setRestaurantOpen(id:$id,expectedVersion:$version,open:$open){id open version}}';
const transitionMutation = 'mutation($id:ID!,$status:String!,$expected:String!){transitionOrder(orderId:$id,status:$status,expectedStatus:$expected){id status paymentStatus history{status}}}';
const assignMutation = 'mutation($id:ID!,$rider:ID!,$expected:String!){assignRider(orderId:$id,riderId:$rider,expectedStatus:$expected){id riderId status}}';
try {
  mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1', dbName: 'delifast_admin_smoke' } });
  env = { ...process.env, NODE_ENV: 'development', MONGODB_URI: mongo.getUri(), HOST: '127.0.0.1', PORT: String(apiPort), DELIFAST_DEMO_PAYMENTS: 'false', PAYMENT_PROVIDER: '', PAYDUNYA_ENABLED: 'false', PAYDUNYA_LIVE_AUTHORIZED: 'false', ORANGE_SMS_ENABLED: 'false', RATE_LIMIT_MAX: '1000', DELIFAST_LOCAL_MODE: 'true', DELIFAST_API_URL: `http://127.0.0.1:${apiPort}/graphql`, NEXT_TELEMETRY_DISABLED: '1' };
  await cli('dist/migrations/index.js');
  await cli('dist/migrations/index.js'); // Re-running the index migration must be safe.
  await cli('dist/migrations/seed.js');
  const server = start(['dist/src/server.js'], `${root}delifast-api`);
  await ready(`http://127.0.0.1:${apiPort}/health`, server);
  const web = start(['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], `${root}enatega-multivendor-admin`, { NODE_ENV: 'production' });
  await ready(`${origin}/delifast`, web);
  const page = await (await fetch(`${origin}/delifast`)).text();
  assert.match(page, /Delifast/);
  const historical = await fetch(`${origin}/en/admin`, { redirect: 'manual' });
  assert.ok(historical.status === 404 || (historical.status >= 300 && historical.status < 400), `Route historique exposée : ${historical.status}`);
  ok('entrée admin locale répond et routes historiques isolées');
  await rejected(ordersQuery, {}, undefined, 'UNAUTHENTICATED');
  await rejected('mutation{staffLogin(email:"admin@delifast.local",password:"incorrect"){token}}', {}, undefined, 'UNAUTHENTICATED');
  const login = async (email, password) => (await gql('mutation($email:String!,$password:String!){staffLogin(email:$email,password:$password){token user{id role restaurantId}}}', { email, password })).staffLogin;
  const admin = await login('admin@delifast.local', 'AdminDemo!2026');
  const restaurant = await login('restaurant1@delifast.local', 'RestaurantDemo!2026');
  const other = await login('restaurant2@delifast.local', 'RestaurantDemo!2026');
  const rider = await login('rider@delifast.local', 'RiderDemo!2026');
  assert.equal((await gql('{me{id role}}', {}, admin.token)).me.role, 'ADMIN');
  // Contrat legacy intentionnel : vérifier que le catalogue reste interdit aux restaurants.
  await rejected('{availableRiders{id}}', {}, restaurant.token, 'FORBIDDEN');
  await rejected(restaurantsQuery, {}, rider.token, 'FORBIDDEN');
  const client = new DelifastClient(`${origin}/api/delifast/graphql`);
  assert.equal((await client.login('admin@delifast.local', 'AdminDemo!2026')).role, 'ADMIN');
  assert.equal((await client.snapshot()).restaurants.length, 2);
  ok('proxy transmet les sessions et backend refuse les accès sans droits');
  const restaurants = (await gql(restaurantsQuery, {}, admin.token)).operationsRestaurants;
  assert.equal(restaurants.length, 2);
  const own = restaurants.find(x => x.id === restaurant.user.restaurantId);
  assert.ok(own);
  const zoneInput = {name:'Zone fictive recette admin',shape:'CIRCLE',center:{latitude:12.3714,longitude:-1.5197},radiusMeters:2000,polygon:null,enabled:true,feeXof:777,minimumOrderXof:0,estimatedMinutes:42,priority:-50,demo:true,hours:[]};
  const zone = await client.createDeliveryZone(own.id, zoneInput);
  assert.equal(zone.shape,'CIRCLE');
  assert.ok((await client.deliveryZones(own.id)).some(z=>z.id===zone.id));
  const eligible = (await gql('query($r:ID!,$p:DeliveryPointInput!){deliveryEligibility(restaurantId:$r,point:$p){zoneId deliveryFee}}',{r:own.id,p:zoneInput.center})).deliveryEligibility;
  assert.equal(eligible.zoneId,zone.id); assert.equal(eligible.deliveryFee,777);
  await rejected('mutation($r:ID!,$i:DeliveryZoneInput!){createDeliveryZone(restaurantId:$r,input:$i){id}}',{r:own.id,i:zoneInput},restaurant.token,'FORBIDDEN');
  await rejected('query($r:ID!){deliveryZones(restaurantId:$r){id}}',{r:own.id},other.token,'FORBIDDEN');
  const zoneUpdated=await client.updateDeliveryZone(zone.id,zone.version,{...zoneInput,enabled:false,feeXof:987});
  assert.equal(zoneUpdated.version,zone.version+1); assert.equal(zoneUpdated.enabled,false);
  await assert.rejects(client.updateDeliveryZone(zone.id,zone.version,zoneInput),e=>e.code==='CONCURRENT_MODIFICATION');
  ok('zones créées et modifiées via le client admin : tarif serveur, isolation et version périmée vérifiés');
  const currentOwn = (await client.snapshot()).restaurants.find(r => r.id === own.id);
  const closed = (await gql(openMutation, { id: own.id, version: currentOwn.version, open: false }, admin.token)).setRestaurantOpen;
  assert.equal(closed.open, false);
  assert.equal(closed.version, currentOwn.version + 1);
  await rejected(openMutation, { id: own.id, version: currentOwn.version, open: true }, admin.token, 'CONCURRENT_MODIFICATION');
  await rejected(openMutation, { id: own.id, version: closed.version, open: true }, other.token, 'FORBIDDEN');
  await rejected(openMutation, { id: own.id, version: closed.version, open: true }, rider.token, 'FORBIDDEN');
  await client.setRestaurantOpen(own.id, closed.version, true);
  ok('restaurants : ouverture versionnée, concurrence et cloisonnement vérifiés');
  const scheduleMutation = 'mutation($id:ID!,$v:Int!,$s:[RestaurantHoursInput!]){setRestaurantSchedule(id:$id,expectedVersion:$v,weeklySchedule:$s){id version weeklySchedule{day startMinute endMinute}}}';
  const scheduledOwn = await client.operationsRestaurant(own.id);
  assert.equal(scheduledOwn.weeklySchedule, null);
  for (const [staff, code] of [[undefined, 'UNAUTHENTICATED'], [other, 'FORBIDDEN'], [rider, 'FORBIDDEN']]) {
    await rejected(scheduleMutation, { id: own.id, v: scheduledOwn.version, s: [] }, staff?.token, code);
  }
  const scheduledClosed = await client.setRestaurantSchedule(own.id, scheduledOwn.version, []);
  assert.equal(scheduledClosed.open, true, 'Les opérations conservent l’interrupteur manuel');
  assert.deepEqual(scheduledClosed.weeklySchedule, []);
  assert.equal((await gql('query($id:ID!){restaurant(id:$id){open}}', { id: own.id })).restaurant.open, false);
  await rejected('query($r:ID!,$p:DeliveryPointInput!){deliveryEligibility(restaurantId:$r,point:$p){zoneId}}', { r: own.id, p: zoneInput.center }, undefined, 'RESTAURANT_CLOSED');
  await assert.rejects(client.setRestaurantSchedule(own.id, scheduledOwn.version, null), e => e.code === 'CONCURRENT_MODIFICATION');
  const scheduledOpen = (await gql(scheduleMutation, { id: own.id, v: scheduledClosed.version, s: null }, restaurant.token)).setRestaurantSchedule;
  assert.equal(scheduledOpen.weeklySchedule, null);
  assert.equal((await gql('query($id:ID!){restaurant(id:$id){open}}', { id: own.id })).restaurant.open, true);
  ok('horaires restaurant : null/vide, ouverture effective, droits propriétaire, refus hors horaires et CAS via le vrai proxy');
  // Profils exclusivement fictifs dans la base jetable, sans création de compte.
  const profileInput = { name: 'Profil restaurant fictif — ne pas livrer', description: 'Fixture de recette sans activité commerciale', open: false, deliveryZoneIds: [zone.id] };
  const profileMutation = 'mutation($input:RestaurantProfileInput!){createRestaurantProfile(input:$input){id version deliveryZoneIds}}';
  await rejected(profileMutation, { input: profileInput }, undefined, 'UNAUTHENTICATED');
  for (const staff of [restaurant, other, rider]) await rejected(profileMutation, { input: profileInput }, staff.token, 'FORBIDDEN');
  await assert.rejects(client.createRestaurantProfile({ ...profileInput, name: ' ' }), e => e.code === 'INVALID_INPUT');
  await assert.rejects(client.createRestaurantProfile({ ...profileInput, deliveryZoneIds: ['zone-inconnue-fictive'] }), e => e.code === 'ZONE_NOT_FOUND');
  const profile = await client.createRestaurantProfile(profileInput);
  assert.equal(profile.version, 0); assert.equal(profile.open, false);
  assert.deepEqual(profile.deliveryZoneIds, [zone.id]);
  assert.ok((await client.deliveryZones()).some(z => z.id === zone.id && z.restaurantId === own.id));
  assert.deepEqual((await client.deliveryZones(profile.id)).map(z => z.id), [zone.id]);
  const linked = (await client.deliveryZones(own.id)).find(z => z.id !== zone.id && z.enabled);
  assert.ok(linked, 'Une zone de démonstration active doit rester disponible');
  const updatedProfile = await client.updateRestaurantProfile(profile.id, profile.version, { ...profileInput, name: 'Profil fictif modifié', deliveryZoneIds: [linked.id] });
  assert.equal(updatedProfile.version, 1);
  await assert.rejects(client.updateRestaurantProfile(profile.id, profile.version, profileInput), e => e.code === 'CONCURRENT_MODIFICATION');
  await assert.rejects(client.updateRestaurantProfile(profile.id, updatedProfile.version, { ...profileInput, deliveryZoneIds: ['zone-inconnue-fictive'] }), e => e.code === 'ZONE_NOT_FOUND');
  const persistedProfile = await client.operationsRestaurant(profile.id);
  assert.equal(persistedProfile.name, 'Profil fictif modifié');
  assert.deepEqual(persistedProfile.deliveryZoneIds, [linked.id]);
  const openedProfile = await client.setRestaurantOpen(profile.id, updatedProfile.version, true);
  const attachedEligibility = (await gql('query($r:ID!,$p:DeliveryPointInput!){deliveryEligibility(restaurantId:$r,point:$p){zoneId deliveryFee}}', { r: profile.id, p: zoneInput.center })).deliveryEligibility;
  assert.equal(attachedEligibility.zoneId, linked.id);
  assert.equal(attachedEligibility.deliveryFee, linked.feeXof);
  await client.updateRestaurantProfile(profile.id, openedProfile.version, { ...profileInput, open: true, deliveryZoneIds: [] });
  await rejected('query($r:ID!,$p:DeliveryPointInput!){deliveryEligibility(restaurantId:$r,point:$p){zoneId}}', { r: profile.id, p: zoneInput.center }, undefined, 'OUT_OF_DELIVERY_ZONE');
  ok('profils restaurant : création/modification via proxy, droits, validation, zone inconnue, rattachement sans déplacement, persistance et conflit');
  async function place() {
    return (await gql('mutation($input:PlaceOrderInput!){placeOrder(input:$input){id status accessToken checkout{total}}}', { input: {
      restaurantId: own.id, items: [{ menuItemId: 'riz-gras', quantity: 2 }], idempotencyKey: `admin-${randomUUID()}`,
      deliveryAddress: { recipientName: 'Recette admin fictive', phone: '+22670000000', city: 'Ouagadougou', neighborhood: 'Démo', landmark: 'Ne pas livrer', instructions: 'Test sans livraison', point: { latitude: 12.3714, longitude: -1.5197 } },
    } })).placeOrder;
  }
  const pending = await place();
  const snapshot = (await gql(ordersQuery, {}, admin.token)).operationsOrders;
  assert.ok(snapshot.some(x => x.id === pending.id && x.status === 'PAYMENT_PENDING'));
  assert.ok(snapshot.every(x => x.accessToken === ''));
  assert.equal((await gql(ordersQuery, {}, restaurant.token)).operationsOrders.length, 0);
  await rejected(transitionMutation, { id: pending.id, expected: 'CONFIRMED', status: 'ACCEPTED' }, admin.token, 'PAYMENT_REQUIRED');
  ok('admin voit les impayées sans jeton client ; restaurant ne les voit pas et aucune avance sans paiement');
  // Fixture de test UNIQUEMENT dans MongoMemoryServer : aucun appel paiement, même simulé.
  dbClient = await MongoClient.connect(mongo.getUri());
  const db = dbClient.db();
  const supportTicketId = `support-reopen-${randomUUID()}`;
  const supportTimes = [0, 1, 2].map(offset => new Date(Date.now() + offset).toISOString());
  await db.collection('support_tickets').insertOne({
    id: supportTicketId,
    creatorId: restaurant.user.id,
    creatorRole: 'RESTAURANT',
    restaurantId: restaurant.user.restaurantId,
    scopeTenant: restaurant.user.restaurantId,
    customerId: null,
    subject: 'Réouverture support fictive',
    description: 'Fixture jetable pour vérifier la réouverture administrative',
    status: 'RESOLVED',
    version: 2,
    createdAt: supportTimes[0],
    updatedAt: supportTimes[2],
    history: [
      { status: 'OPEN', at: supportTimes[0], actorRole: 'RESTAURANT', note: '' },
      { status: 'IN_PROGRESS', at: supportTimes[1], actorRole: 'ADMIN', note: 'Prise en charge initiale' },
      { status: 'RESOLVED', at: supportTimes[2], actorRole: 'ADMIN', note: 'Résolution initiale' },
    ],
    idempotencyKey: `fixture-${randomUUID()}`,
    payloadFingerprint: 'fixture-only',
  });
  const summariesQuery = 'query($id:ID,$status:SupportStatus){operationsSupportTicketSummaries(limit:20,offset:0,ticketId:$id,status:$status){id subject creatorRole status version createdAt updatedAt}}';
  for (const [token, code] of [[undefined, 'UNAUTHENTICATED'], [restaurant.token, 'FORBIDDEN'], [rider.token, 'FORBIDDEN']]) {
    await rejected(summariesQuery, { id: supportTicketId, status: 'RESOLVED' }, token, code);
  }
  const summaries = await client.operationsSupportTicketSummaries(20, 0, supportTicketId);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, supportTicketId);
  assert.deepEqual(Object.keys(summaries[0]).sort(), ['id', 'subject', 'creatorRole', 'status', 'version', 'createdAt', 'updatedAt'].sort());
  const rawSummaries = (await gql(summariesQuery, { id: supportTicketId }, admin.token)).operationsSupportTicketSummaries;
  assert.deepEqual(rawSummaries, summaries);
  assert.deepEqual(await client.operationsSupportTicketSummaries(20, 0, 'inconnu-fictif'), []);
  await rejected(summariesQuery, { id: 'x'.repeat(129) }, admin.token, 'INVALID_INPUT');
  await rejected('{operationsSupportTicketSummaries(offset:10001){id}}', {}, admin.token, 'INVALID_INPUT');
  const forbiddenSummaryField = await raw('{operationsSupportTicketSummaries{description}}', {}, admin.token);
  assert.ok(forbiddenSummaryField.errors?.length, 'Le résumé ne doit pas exposer les messages');
  ok('résumés Support : recherche exacte, projection minimale, bornes et refus hors ADMIN via le vrai proxy');
  const supportIndexes = await db.collection('support_tickets').indexes();
  assert.deepEqual(supportIndexes.find(index => index.name === 'support_status_created')?.key, { status: 1, createdAt: 1, id: 1 });
  for (const status of ['OPEN', 'IN_PROGRESS', 'RESOLVED']) {
    const filtered = await client.operationsSupportTicketSummaries(20, 0, supportTicketId, status);
    assert.deepEqual(filtered.map(row => row.id), status === 'RESOLVED' ? [supportTicketId] : []);
    const server = (await gql(summariesQuery, { id: supportTicketId, status }, admin.token)).operationsSupportTicketSummaries;
    assert.deepEqual(server, filtered);
  }
  await rejected(summariesQuery, { status: 'UNKNOWN' }, admin.token, 'INVALID_INPUT');
  ok('statuts Support côté serveur : trois valeurs, combinaison identifiant/statut, index migré et enum invalide refusé');
  const supportBefore = await client.operationsSupportTicket(supportTicketId);
  assert.equal(supportBefore.status, 'RESOLVED');
  assert.equal(supportBefore.version, 2);
  assert.equal(supportBefore.history.length, 3);
  await assert.rejects(
    client.transitionSupportTicket(supportTicketId, supportBefore.version, 'IN_PROGRESS', '   '),
    e => e.code === 'INVALID_INPUT',
  );
  for (const [token, code] of [[undefined, 'UNAUTHENTICATED'], [restaurant.token, 'FORBIDDEN'], [rider.token, 'FORBIDDEN']]) {
    await rejected(
      'mutation($id:ID!,$v:Int!,$s:SupportStatus!,$n:String!){transitionSupportTicket(id:$id,expectedVersion:$v,status:$s,note:$n){id}}',
      { id: supportTicketId, v: 2, s: 'IN_PROGRESS', n: 'Tentative interdite' }, token, code,
    );
  }
  const reopened = await client.transitionSupportTicket(
    supportTicketId, supportBefore.version, 'IN_PROGRESS', 'Motif de réouverture vérifié',
  );
  assert.equal(reopened.status, 'IN_PROGRESS');
  assert.equal(reopened.version, 3);
  assert.equal(reopened.history.length, 4);
  assert.equal(reopened.history[2].note, 'Résolution initiale');
  assert.equal(reopened.history[3].note, 'Motif de réouverture vérifié');
  assert.equal(reopened.history[3].actorRole, 'ADMIN');
  assert.ok(!('actorId' in reopened.history[3]), 'actorId ne doit pas sortir du client');
  const ownerView = (await gql(
    'query($id:ID!){staffSupportTicket(id:$id){status version history{status note}}}',
    { id: supportTicketId }, restaurant.token,
  )).staffSupportTicket;
  assert.equal(ownerView.status, 'IN_PROGRESS');
  assert.equal(ownerView.version, 3);
  assert.equal(ownerView.history[3].note, 'Motif de réouverture vérifié');
  await assert.rejects(
    client.transitionSupportTicket(supportTicketId, supportBefore.version, 'IN_PROGRESS', 'Rejeu obsolète'),
    e => e.code === 'CONCURRENT_MODIFICATION',
  );
  const persistedSupport = await db.collection('support_tickets').findOne({ id: supportTicketId });
  assert.equal(persistedSupport.version, 3);
  assert.equal(persistedSupport.history.length, 4);
  assert.equal(persistedSupport.history[3].actorId, admin.user.id);
  assert.equal(persistedSupport.history[3].note, 'Motif de réouverture vérifié');
  const internalField = await raw(
    'query($id:ID!){operationsSupportTicket(id:$id){id history{status actorId}}}',
    { id: supportTicketId }, admin.token,
  );
  assert.ok(internalField.errors?.some(error => error.extensions?.code === 'GRAPHQL_VALIDATION_FAILED'));
  assert.ok(!internalField.data, 'Un champ interne ne doit pas produire de données');
  ok('réouverture support RESOLVED→IN_PROGRESS : proxy réel, droits, motif, CAS, historique et audit interne');
  async function paidFixture() {
    const order = await place();
    await db.collection('orders').updateOne({ id: order.id }, { $set: { status: 'CONFIRMED', paymentStatus: 'PAID' }, $push: { history: { status: 'CONFIRMED', at: new Date().toISOString(), actorRole: 'SYSTEM' } } });
    return order;
  }
  const paid = await paidFixture();
  const visible = (await gql(ordersQuery, {}, admin.token)).operationsOrders.find(x => x.id === paid.id);
  assert.equal(visible.checkout.total, paid.checkout.total);
  assert.equal(visible.deliveryAddress.recipientName, 'Recette admin fictive');
  await rejected(transitionMutation, { id: paid.id, expected: 'CONFIRMED', status: 'DELIVERED' }, admin.token, 'INVALID_TRANSITION');
  await client.transition(paid.id, 'ACCEPTED', 'CONFIRMED');
  await rejected(transitionMutation, { id: paid.id, expected: 'CONFIRMED', status: 'ACCEPTED' }, admin.token, 'CONCURRENT_MODIFICATION');
  const riderPage = (await gql('query RiderSummary($limit:Int,$riderId:ID){operationsRiderSummaries(limit:$limit,riderId:$riderId){items{id name} nextCursor}}', { limit: 20, riderId: rider.user.id }, admin.token)).operationsRiderSummaries;
  assert.deepEqual(riderPage.items.map(x => x.id), [rider.user.id], 'Le filtre exact doit retrouver le livreur actif hors page');
  assert.equal(riderPage.nextCursor, null);
  await rejected(assignMutation, { id: paid.id, rider: rider.user.id, expected: 'ACCEPTED' }, restaurant.token, 'FORBIDDEN');
  await client.assignRider(paid.id, rider.user.id, 'ACCEPTED');
  await gql(transitionMutation, { id: paid.id, expected: 'ACCEPTED', status: 'PREPARING' }, admin.token);
  await gql(transitionMutation, { id: paid.id, expected: 'PREPARING', status: 'READY' }, admin.token);
  await gql(transitionMutation, { id: paid.id, expected: 'READY', status: 'PICKED_UP' }, rider.token);
  await gql(transitionMutation, { id: paid.id, expected: 'PICKED_UP', status: 'DELIVERED' }, rider.token);
  const delivered = (await gql(ordersQuery, {}, admin.token)).operationsOrders.find(x => x.id === paid.id);
  assert.deepEqual(delivered.history.map(x => x.status), ['PAYMENT_PENDING', 'CONFIRMED', 'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'DELIVERED']);
  ok('commandes : snapshots, transitions autorisées, conflit, affectation admin et livraison fictive');
  const cancel = await paidFixture();
  const cancelled = (await gql(transitionMutation, { id: cancel.id, expected: 'CONFIRMED', status: 'CANCELLED' }, admin.token)).transitionOrder;
  assert.equal(cancelled.paymentStatus, 'REFUND_PENDING');
  await rejected(transitionMutation, { id: cancel.id, expected: 'CANCELLED', status: 'ACCEPTED' }, admin.token, 'INVALID_TRANSITION');
  ok('annulation terminale avec remboursement en attente uniquement, aucun remboursement exécuté');
  // Catalogue volumineux exclusivement synthétique : résumés bornés et détail séparé.
  const catalogFixtures = Array.from({ length: 125 }, (_, i) => ({ id: `z-admin-catalog-${String(i).padStart(3, '0')}`, name: `Restaurant synthétique ${i}`, description: 'Détail privé de fixture', open: i % 2 === 0, version: 0, weeklySchedule: null, deliveryZoneIds: [], audit: [{ note: 'x'.repeat(20000) }] }));
  await db.collection('restaurants').insertMany(catalogFixtures);
  const catalogIds = [];
  let catalogAfter;
  do {
    const page = await client.snapshot({}, undefined, catalogAfter);
    assert.ok(page.restaurants.length <= 20);
    assert.ok(page.restaurants.every(row => Object.keys(row).sort().join(',') === 'id,name,open,version'));
    catalogIds.push(...page.restaurants.map(row => row.id));
    catalogAfter = page.restaurantNextCursor || undefined;
  } while (catalogAfter);
  assert.equal(new Set(catalogIds).size, catalogIds.length);
  assert.equal(catalogIds.length, 128);
  const exactCatalog = await client.snapshot({}, undefined, undefined, 'z-admin-catalog-124');
  assert.deepEqual(exactCatalog.restaurants.map(row => row.id), ['z-admin-catalog-124']);
  assert.equal(exactCatalog.restaurantNextCursor, null);
  const exactDetail = await client.operationsRestaurant('z-admin-catalog-124');
  assert.equal(exactDetail.description, 'Détail privé de fixture');
  assert.equal(exactDetail.weeklySchedule, null);
  const summaryQuery = 'query($limit:Int,$after:ID,$id:ID){operationsRestaurantSummaries(limit:$limit,after:$after,restaurantId:$id){items{id name open version} nextCursor}}';
  for (const [token, code] of [[undefined, 'UNAUTHENTICATED'], [restaurant.token, 'FORBIDDEN'], [rider.token, 'FORBIDDEN']]) {
    await rejected(summaryQuery, {}, token, code);
    await rejected('query{operationsRestaurant(id:"rest-koudougou"){id}}', {}, token, code);
  }
  for (const variables of [{ limit: 0 }, { limit: 51 }, { after: '' }, { id: ' ' }]) await rejected(summaryQuery, variables, admin.token, 'INVALID_INPUT');
  const privateSummary = await raw('{operationsRestaurantSummaries{items{id description}}}', {}, admin.token);
  assert.ok(privateSummary.errors?.length);
  for (const filter of [{}, { id: { $gt: 'z-admin-catalog-050' } }, { id: 'z-admin-catalog-124' }]) {
    const explain = await db.collection('restaurants').find(filter).project({ _id: 0, id: 1, name: 1, open: 1, version: 1 }).sort({ id: 1 }).limit(21).explain('executionStats');
    const plan = JSON.stringify(explain.queryPlanner.winningPlan);
    assert.match(plan, /IXSCAN/); assert.doesNotMatch(plan, /COLLSCAN|"stage":"SORT"/);
    assert.ok(explain.executionStats.totalDocsExamined <= 21);
  }
  ok('catalogue restaurants : 128 profils sur pages de 20, filtre ID exact, résumé minimal, détail ciblé, droits ADMIN et plans indexés sans tri bloquant');
  // Catalogue livreurs : documents riches jetables, jamais des positions ni des comptes réels.
  const riderFixtures = Array.from({ length: 125 }, (_, i) => ({
    id: `z-admin-rider-${String(i).padStart(3, '0')}`, name: `Livreur synthétique ${i}`,
    email: `rider-${i}@fixture.invalid`, passwordHash: 'fixture-non-authenticable',
    role: 'RIDER', active: true, restaurantId: null, internalAudit: 'x'.repeat(20000),
  }));
  await db.collection('staff_users').insertMany([...riderFixtures,
    { ...riderFixtures[0], id: 'z-admin-inactive', email: 'inactive@fixture.invalid', active: false },
    { ...riderFixtures[0], id: 'z-admin-non-rider', email: 'non-rider@fixture.invalid', role: 'RESTAURANT' },
  ]);
  const riderSummaryQuery = 'query($limit:Int,$after:ID,$id:ID){operationsRiderSummaries(limit:$limit,after:$after,riderId:$id){items{id name} nextCursor}}';
  const riderDetailQuery = 'query($id:ID!){operationsRider(id:$id){id name role restaurantId}}';
  const riderIds = [];
  let riderAfter;
  do {
    const page = (await gql(riderSummaryQuery, { limit: 20, ...(riderAfter ? { after: riderAfter } : {}) }, admin.token)).operationsRiderSummaries;
    assert.ok(page.items.length <= 20);
    assert.ok(page.items.every(row => Object.keys(row).sort().join(',') === 'id,name'));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 10000);
    riderIds.push(...page.items.map(row => row.id));
    riderAfter = page.nextCursor;
  } while (riderAfter);
  assert.equal(new Set(riderIds).size, riderIds.length);
  assert.equal(riderIds.length, 126);
  assert.ok(!riderIds.includes('z-admin-inactive') && !riderIds.includes('z-admin-non-rider'));
  const exactRider = (await gql(riderSummaryQuery, { id: 'z-admin-rider-124' }, admin.token)).operationsRiderSummaries;
  assert.deepEqual(exactRider.items, [{ id: 'z-admin-rider-124', name: 'Livreur synthétique 124' }]);
  assert.equal(exactRider.nextCursor, null);
  const riderDetail = (await gql(riderDetailQuery, { id: 'z-admin-rider-124' }, admin.token)).operationsRider;
  assert.deepEqual(riderDetail, { ...exactRider.items[0], role: 'RIDER', restaurantId: null });
  for (const id of ['z-admin-inactive', 'z-admin-non-rider', 'inconnu-fictif']) {
    assert.deepEqual((await gql(riderSummaryQuery, { id }, admin.token)).operationsRiderSummaries.items, []);
    assert.equal((await gql(riderDetailQuery, { id }, admin.token)).operationsRider, null);
  }
  for (const [token, code] of [[undefined, 'UNAUTHENTICATED'], [restaurant.token, 'FORBIDDEN'], [rider.token, 'FORBIDDEN']]) {
    await rejected(riderSummaryQuery, {}, token, code);
    await rejected(riderDetailQuery, { id: 'z-admin-rider-124' }, token, code);
  }
  for (const variables of [{ limit: 0 }, { limit: 51 }, { after: '' }, { id: ' ' }])
    await rejected(riderSummaryQuery, variables, admin.token, 'INVALID_INPUT');
  for (const query of ['{operationsRiderSummaries{items{id role}}}', '{operationsRider(id:"z-admin-rider-124"){id email passwordHash internalAudit}}']) {
    const response = await raw(query, {}, admin.token);
    assert.ok(response.errors?.length && !response.data);
  }
  const maxRiders = (await gql(riderSummaryQuery, { limit: 50 }, admin.token)).operationsRiderSummaries;
  assert.equal(maxRiders.items.length, 50);
  assert.equal(maxRiders.nextCursor, maxRiders.items.at(-1).id);
  for (const extra of [{}, { id: { $gt: 'z-admin-rider-050' } }, { id: 'z-admin-rider-124' }]) {
    const explain = await db.collection('staff_users').find({ role: 'RIDER', active: true, ...extra })
      .project({ _id: 0, id: 1, name: 1 }).sort({ id: 1 }).limit(21).explain('executionStats');
    const plan = JSON.stringify(explain.queryPlanner.winningPlan);
    assert.match(plan, /IXSCAN/); assert.doesNotMatch(plan, /COLLSCAN|"stage":"SORT"/);
    assert.ok(explain.executionStats.totalDocsExamined <= 21);
  }
  const assignment = await paidFixture();
  await client.transition(assignment.id, 'ACCEPTED', 'CONFIRMED');
  await client.assignRider(assignment.id, riderDetail.id, 'ACCEPTED');
  assert.equal((await client.operationsOrder(assignment.id)).riderId, riderDetail.id);
  await assert.rejects(client.assignRider(assignment.id, 'z-admin-inactive', 'ACCEPTED'), e => e.code === 'RIDER_NOT_FOUND');
  ok('catalogue livreurs : 126 actifs, pages 20 et borne 50, ID hors page, projection minimale, détail ciblé, droits et index sans tri bloquant ; affectation fictive hors première page');
  await client.logout();
  assert.equal(client.hasSession, false);
  for (const session of [admin, restaurant, other, rider]) await gql('mutation{staffLogout}', {}, session.token);
  await rejected(ordersQuery, {}, admin.token, 'UNAUTHENTICATED');
  ok('déconnexion révoque réellement la session via le proxy admin');
  console.log(`SUCCÈS — ${checks} contrôles HTTP admin/API/MongoDB jetable. Aucun paiement ni compte créé hors seed de test.`);
} finally {
  if (dbClient) await dbClient.close();
  for (const child of [...children].reverse()) {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  }
  if (mongo) await mongo.stop();
}
