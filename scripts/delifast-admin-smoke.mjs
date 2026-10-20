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
  const scheduledOwn = (await client.snapshot()).restaurants.find(r => r.id === own.id);
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
  const persistedProfile = (await client.snapshot()).restaurants.find(r => r.id === profile.id);
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
  const riders = (await gql('{availableRiders{id name role}}', {}, admin.token)).availableRiders;
  assert.ok(riders.some(x => x.id === rider.user.id));
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
