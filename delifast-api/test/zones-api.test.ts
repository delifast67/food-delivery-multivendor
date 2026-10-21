import { beforeAll, afterAll, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import crypto from "node:crypto";
import { quoteInput } from "./quote-helper.js";
let mongo: MongoMemoryServer, app: any, db: any, token: string, zone: any;
const point = { latitude: 12.3714, longitude: -1.5197 };
const call = async (query: string, variables: any = {}, auth?: string) => (await request(app).post('/graphql').set(auth ? {authorization:`Bearer ${auth}`} : {}).send({query, variables})).body;
const address = { recipientName:'Essai fictif', phone:'+22670000000', city:'Ville libre fictive', neighborhood:'Repère', landmark:'Aucune livraison réelle', instructions:'', point };
const cart = {restaurantId:'rest-koudougou',items:[{menuItemId:'riz-gras',quantity:1}]};
const input = (key: string, p: any = point) => ({...cart,idempotencyKey:key,deliveryAddress:{...address,point:p}});
const place = 'mutation($i:PlaceOrderInput!){placeOrder(input:$i){id accessToken checkout{total deliveryFee delivery{zoneId zoneVersion deliveryFee demo}}}}';
const quoted = (i: any) => quoteInput(call, i);
const zoneFields = 'id restaurantId name shape center{latitude longitude} radiusMeters polygon{latitude longitude} enabled feeXof minimumOrderXof estimatedMinutes priority demo hours{day startMinute endMinute} version';
const update = async (changes: any) => {
  const {id,restaurantId,version,...data} = zone;
  const result = await call(`mutation($id:ID!,$v:Int!,$i:DeliveryZoneInput!){updateDeliveryZone(id:$id,expectedVersion:$v,input:$i){${zoneFields}}}`,{id,v:version,i:{...data,...changes}},token);
  expect(result.errors).toBeUndefined(); zone=result.data.updateDeliveryZone;
};
beforeAll(async()=>{
 process.env.NODE_ENV='test'; process.env.RATE_LIMIT_MAX='1000';
 mongo=await MongoMemoryServer.create(); process.env.MONGODB_URI=mongo.getUri();
 db=await (await import('../src/db.js')).connect();
 await (await import('../migrations/seed.js')).seedAll(db);
 app=await (await import('../src/server.js')).createApp();
 token=(await call('mutation{staffLogin(email:"admin@delifast.local",password:"AdminDemo!2026"){token}}')).data.staffLogin.token;
 zone=(await call(`query{deliveryZones{${zoneFields}}}`,{},token)).data.deliveryZones.find((z:any)=>z.restaurantId===cart.restaurantId);
},60000);
afterAll(async()=>{await (await import('../src/db.js')).closeDb();await mongo.stop();});
it('requires GPS before insertion, rejects a foreign point and does not trust the city name',async()=>{
 const before=await db.collection('orders').countDocuments();
 const missing=input('missing-point'); delete missing.deliveryAddress.point;
 expect((await call(place,{i:missing})).errors[0].extensions.code).toBe('DELIVERY_POINT_REQUIRED');
 expect((await call(place,{i:input('outside-point',{latitude:0,longitude:0})})).errors[0].extensions.code).toBe('OUT_OF_DELIVERY_ZONE');
 expect(await db.collection('orders').countDocuments()).toBe(before);
 const valid=await call(place,{i:await quoted(input('valid-free-city'))});
 expect(valid.errors).toBeUndefined(); expect(valid.data.placeOrder.checkout.delivery.demo).toBe(true);
});
it('filters discovery per restaurant and checks current fees, minimum and availability again at placement',async()=>{
 const publicList=await call('query($p:DeliveryPointInput!){restaurants(point:$p){id}}',{p:point});
 expect(publicList.data.restaurants).toHaveLength(2);
 await update({enabled:false});
 const filtered=await call('query($p:DeliveryPointInput!){restaurants(point:$p){id}}',{p:point});
 expect(filtered.data.restaurants.map((r:any)=>r.id)).toEqual(['rest-ouaga-centre']);
 expect((await call(place,{i:input('disabled-zone')})).errors[0].extensions.code).toBe('OUT_OF_DELIVERY_ZONE');
 await update({enabled:true,minimumOrderXof:3000});
 expect((await call(place,{i:input('below-minimum')})).errors[0].extensions.code).toBe('MINIMUM_ORDER_NOT_MET');
 await update({minimumOrderXof:0,feeXof:731});
 const q=await call('query($i:CartInput!){calculateCheckout(input:$i){deliveryFee delivery{zoneVersion}}}',{i:{...cart,point}});
 expect(q.data.calculateCheckout.deliveryFee).toBe(731);
 await update({feeXof:913});
 const current=await quoted(input('current-fee-proof'));
 const placed=await call(place,{i:current});
 expect(placed.data.placeOrder.checkout.deliveryFee).toBe(913);
 expect(placed.data.placeOrder.checkout.delivery.zoneVersion).toBe(zone.version);
 await update({enabled:false,feeXof:123});
 expect((await call(place,{i:current})).data.placeOrder).toEqual(placed.data.placeOrder);
 const changed=input('current-fee-proof',{latitude:12.372,longitude:-1.52});
 expect((await call(place,{i:changed})).errors[0].extensions.code).toBe('IDEMPOTENCY_CONFLICT');
 await update({enabled:true,feeXof:500});
});
it('rejects forged fees and invalid points; no matching configured zone fails closed',async()=>{
 const before=await db.collection('orders').countDocuments();
 expect((await call(place,{i:{...input('forged-zone-fee'),deliveryFee:0}})).errors).toBeTruthy();
 expect((await call(place,{i:input('invalid-point',{latitude:91,longitude:0})})).errors[0].extensions.code).toBe('INVALID_POINT');
 await db.collection('restaurants').insertOne({id:'unconfigured',name:'Fictif',description:'Fictif',open:true});
 await db.collection('menu_items').insertOne({id:'unconfigured-meal',restaurantId:'unconfigured',name:'Fictif',priceXof:100,available:true});
 expect((await call(place,{i:{...input('no-configured-zone'),restaurantId:'unconfigured',items:[{menuItemId:'unconfigured-meal',quantity:1}]}})).errors[0].extensions.code).toBe('OUT_OF_DELIVERY_ZONE');
 expect(await db.collection('orders').countDocuments()).toBe(before);
});
it('stores the exact submitted delivery point and protects the address with the order token', async () => {
 const chosen = { latitude: 12.372, longitude: -1.52 };
 const selected = input('chosen-address-snapshot', { ...chosen });
 selected.deliveryAddress.instructions = 'Adresse fictive choisie pour cette commande';
 const fields = 'id accessToken deliveryAddress{recipientName phone city neighborhood landmark instructions point{latitude longitude}} checkout{delivery{zoneId deliveryFee}}';
 const result = await call(`mutation($i:PlaceOrderInput!){placeOrder(input:$i){${fields}}}`, { i: await quoted(selected) });
 expect(result.errors).toBeUndefined();
 const order = result.data.placeOrder;
 expect(order.deliveryAddress).toEqual(selected.deliveryAddress);
 expect(order.checkout.delivery.zoneId).toBe(zone.id);
 expect(order.checkout.delivery.deliveryFee).toBe(zone.feeXof);
 const stored = await db.collection('orders').findOne({ id: order.id });
 expect(stored.deliveryAddress).toEqual(selected.deliveryAddress);
 selected.deliveryAddress.point.latitude = 0;
 expect((await db.collection('orders').findOne({ id: order.id })).deliveryAddress.point).toEqual(chosen);
 const query = `query($id:ID!,$token:String!){order(id:$id,accessToken:$token){${fields}}}`;
 expect((await call(query, { id: order.id, token: order.accessToken })).data.order.deliveryAddress.point).toEqual(chosen);
 expect((await call(query, { id: order.id, token: 'wrong-order-token-long-enough' })).data.order).toBeNull();
 // A staff session is not a customer identity and cannot replace the order token.
 expect((await call(query, { id: order.id, token: 'wrong-order-token-long-enough' }, token)).data.order).toBeNull();
});
it.each([
 ['null point', null, 'DELIVERY_POINT_REQUIRED'],
 ['invalid latitude', { latitude: -91, longitude: -1.5197 }, 'INVALID_POINT'],
 ['invalid longitude', { latitude: 12.3714, longitude: 181 }, 'INVALID_POINT'],
 ['outside configured delivery area', { latitude: 0, longitude: 0 }, 'OUT_OF_DELIVERY_ZONE'],
])('rejects %s without storing an order', async (_name, location, code) => {
 const before = await db.collection('orders').countDocuments();
 const result = await call(place, { i: input(`address-rejection-${code}`, location) });
 expect(result.errors[0].extensions.code).toBe(code);
 expect(await db.collection('orders').countDocuments()).toBe(before);
});
it('preserves a legacy idempotent attempt without GPS but never creates another order from it',async()=>{
 const {normalizeCart,normalizeAddress}=await import('../src/validation.js');
 const legacyAddress={...address}; delete (legacyAddress as any).point;
 const c=normalizeCart(cart),a=normalizeAddress(legacyAddress);
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify({...c,deliveryAddress:a})).digest('hex');
 const old={id:'legacy-zone-order',accessToken:'a'.repeat(48),idempotencyKey:'legacy-zone-key',fingerprint,restaurantId:cart.restaurantId,status:'PAYMENT_PENDING',paymentStatus:'PENDING',createdAt:new Date().toISOString(),deliveryAddress:a,checkout:{currency:'XOF',subtotal:2500,deliveryFee:500,serviceFee:200,tax:0,discount:0,total:3200,items:[]}};
 await db.collection('orders').insertOne(old);
 const replay=await call(place,{i:{...cart,idempotencyKey:old.idempotencyKey,deliveryAddress:legacyAddress}});
 expect(replay.errors).toBeUndefined(); expect(replay.data.placeOrder.id).toBe(old.id);
 expect(replay.data.placeOrder.checkout.delivery).toBeNull();
});
