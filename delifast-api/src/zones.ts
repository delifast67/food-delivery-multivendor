import crypto from "node:crypto";
import type { Db } from "mongodb";
import type { Staff } from "./auth.js";
import { fail } from "./validation.js";
import { restaurantZoneIds } from "./restaurant.js";
import { isRestaurantOpen } from "./restaurant-hours.js";

export type Point = { latitude: number; longitude: number };
export type DeliveryPointInput = Point;
export type ZoneHours = { day: number; startMinute: number; endMinute: number };
export type DeliveryZoneInput = {
  name: string; shape: "CIRCLE" | "POLYGON"; center?: Point | null; radiusMeters?: number | null; polygon?: Point[] | null; hours?: ZoneHours[];
  enabled: boolean; feeXof: number; minimumOrderXof: number;
  estimatedMinutes: number; priority: number; demo: boolean;
};

const MAX_INT = 2147483647;
const EARTH_M = 6371008.8;
const id = (v: unknown, field: string) => {
  if (typeof v !== "string" || !v.trim() || v.length > 128) fail("INVALID_INPUT", `${field} invalide`);
  return v.trim();
};
const point = (v: unknown): Point => {
  if (!v || typeof v !== "object") fail("INVALID_POINT", "Point invalide");
  const x = v as any;
  if (typeof x.latitude !== "number" || !Number.isFinite(x.latitude) || x.latitude < -90 || x.latitude > 90 ||
      typeof x.longitude !== "number" || !Number.isFinite(x.longitude) || x.longitude < -180 || x.longitude > 180)
    fail("INVALID_POINT", "Coordonnées invalides");
  return { latitude: x.latitude, longitude: x.longitude };
};
export function normalizePoint(input: unknown): Point { return point(input); }

function integer(v: unknown, field: string, min = 0, max = MAX_INT) {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) fail("INVALID_INPUT", `${field} invalide`);
  return v as number;
}
function orientation(a: Point, b: Point, c: Point) {
  return (b.longitude-a.longitude)*(c.latitude-a.latitude) - (b.latitude-a.latitude)*(c.longitude-a.longitude);
}
function onSegment(a: Point, b: Point, p: Point) {
  return Math.abs(orientation(a,b,p)) < 1e-12 && p.longitude >= Math.min(a.longitude,b.longitude)-1e-12 && p.longitude <= Math.max(a.longitude,b.longitude)+1e-12 && p.latitude >= Math.min(a.latitude,b.latitude)-1e-12 && p.latitude <= Math.max(a.latitude,b.latitude)+1e-12;
}
function segmentsCross(a: Point,b: Point,c: Point,d: Point) {
  const o1=orientation(a,b,c),o2=orientation(a,b,d),o3=orientation(c,d,a),o4=orientation(c,d,b);
  if ((o1>0&&o2<0||o1<0&&o2>0) && (o3>0&&o4<0||o3<0&&o4>0)) return true;
  return (Math.abs(o1)<1e-12&&onSegment(a,b,c)) || (Math.abs(o2)<1e-12&&onSegment(a,b,d)) || (Math.abs(o3)<1e-12&&onSegment(c,d,a)) || (Math.abs(o4)<1e-12&&onSegment(c,d,b));
}
function polygonValid(poly: Point[]) {
  if (poly.length < 3 || poly.length > 100) fail("INVALID_INPUT", "Polygone invalide");
  const distinct = new Set(poly.map(p => `${p.latitude},${p.longitude}`));
  if (distinct.size !== poly.length) fail("INVALID_INPUT", "Polygone invalide");
  const longs = poly.map(p=>p.longitude);
  if (Math.max(...longs)-Math.min(...longs) > 180) fail("INVALID_INPUT", "Polygone traversant la dateline");
  for (let i=0;i<poly.length;i++) for (let j=i+1;j<poly.length;j++) {
    const adjacent = j===i+1 || (i===0 && j===poly.length-1);
    if (!adjacent && segmentsCross(poly[i],poly[(i+1)%poly.length],poly[j],poly[(j+1)%poly.length])) fail("INVALID_INPUT", "Polygone auto-intersecté");
  }
  if (Math.abs(poly.reduce((s,p,i)=>s+p.longitude*poly[(i+1)%poly.length].latitude-poly[(i+1)%poly.length].longitude*p.latitude,0)) < 1e-12) fail("INVALID_INPUT", "Polygone dégénéré");
  return poly;
}
export function normalizeZoneInput(input: any): DeliveryZoneInput {
  if (!input || typeof input !== "object") fail("INVALID_INPUT", "Zone invalide");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 160) fail("INVALID_INPUT", "Nom invalide");
  if (input.shape !== "CIRCLE" && input.shape !== "POLYGON") fail("INVALID_INPUT", "Géométrie invalide");
  let center: Point | null = null, radiusMeters: number | null = null, polygon: Point[] | null = null;
  if (input.shape === "CIRCLE") {
    if (typeof input.radiusMeters !== "number" || !Number.isFinite(input.radiusMeters) || input.radiusMeters <= 0 || input.radiusMeters > 100000) fail("INVALID_INPUT", "Rayon invalide");
    center = point(input.center); radiusMeters = input.radiusMeters;
  } else polygon = polygonValid((Array.isArray(input.polygon) ? input.polygon : []).map(point));
  if (typeof input.enabled !== "boolean" || typeof input.demo !== "boolean") fail("INVALID_INPUT", "Option invalide");
  const hours = input.hours === undefined ? [] : input.hours;
  if (!Array.isArray(hours) || hours.length > 28) fail("INVALID_INPUT", "Horaires invalides");
  const normalizedHours = hours.map((h: any) => {
    const day=integer(h?.day,"day",0,6), startMinute=integer(h?.startMinute,"startMinute",0,1439), endMinute=integer(h?.endMinute,"endMinute",1,1440);
    if (endMinute<=startMinute) fail("INVALID_INPUT","Horaires invalides");
    return {day,startMinute,endMinute};
  }).sort((a,b)=>a.day-b.day||a.startMinute-b.startMinute);
  for(let i=1;i<normalizedHours.length;i++) if(normalizedHours[i].day===normalizedHours[i-1].day && normalizedHours[i].startMinute<normalizedHours[i-1].endMinute) fail("INVALID_INPUT","Créneaux superposés");
  return {name:input.name.trim(),shape:input.shape,center,radiusMeters,polygon,hours:normalizedHours,enabled:input.enabled,demo:input.demo,feeXof:integer(input.feeXof,"feeXof"),minimumOrderXof:integer(input.minimumOrderXof,"minimumOrderXof"),estimatedMinutes:integer(input.estimatedMinutes,"estimatedMinutes",1,1440),priority:integer(input.priority,"priority",-1000000,1000000)};
}
function actor(user: Staff){return {id:user.id,role:user.role};}
function audit(user: Staff, action: string, version: number){return {actor:actor(user),action,version,at:new Date().toISOString()};}
function view(z:any){
  const shape=z.shape ?? z.geometry?.type;
  return {...z, shape, center:shape === "CIRCLE" ? (z.shape ? z.center : z.geometry?.center) : null,
    radiusMeters:shape === "CIRCLE" ? (z.shape ? z.radiusMeters : z.geometry?.radiusMeters) : null,
    polygon:shape === "POLYGON" ? (z.shape ? z.polygon : z.geometry?.polygon) : null,
    version:Number.isInteger(z.version)?z.version:0, hours:Array.isArray(z.hours)?z.hours:[]};
}
function allowed(user: Staff){if(user.role!=="ADMIN"&&user.role!=="RESTAURANT") fail("FORBIDDEN","Droits insuffisants");}
function scope(user: Staff, restaurantId:string){if(user.role==="RESTAURANT"&&user.restaurantId!==restaurantId) fail("FORBIDDEN","Restaurant hors portée");}
function versionFilter(v:number):any{return v===0?{$or:[{version:0},{version:{$exists:false}}]}:{version:v};}

export async function listDeliveryZones(db:Db,user:Staff,restaurantId?:unknown){
  allowed(user);
  if (user.role === "ADMIN" && (restaurantId === undefined || restaurantId === null))
    return (await db.collection("delivery_zones").find({}).sort({priority:1,id:1}).toArray()).map(view);
  const rid = restaurantId == null ? user.restaurantId : id(restaurantId,"restaurantId");
  if (!rid) fail("INVALID_INPUT", "restaurantId invalide"); scope(user,rid);
  const r = await db.collection<any>("restaurants").findOne({id:rid});
  if (!r) fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  const ids = await restaurantZoneIds(db,r);
  return (await db.collection("delivery_zones").find({id:{$in:ids}}).sort({priority:1,id:1}).toArray()).map(view);
}
export async function createDeliveryZone(db:Db,user:Staff,restaurantIdRaw:unknown,input:any){
  if(user.role!=="ADMIN") fail("FORBIDDEN","Droits insuffisants"); const restaurantId=id(restaurantIdRaw,"restaurantId"); scope(user,restaurantId);
  const restaurant = await db.collection<any>("restaurants").findOne({id:restaurantId});
  if(!restaurant) fail("RESTAURANT_NOT_FOUND","Restaurant introuvable");
  const value=normalizeZoneInput(input), item={id:crypto.randomUUID(),restaurantId,...value,version:0,audit:[audit(user,"DELIVERY_ZONE_CREATED",0)],createdAt:new Date(),updatedAt:new Date()};
  await db.collection("delivery_zones").insertOne(item);
  const expectedVersion = Number.isInteger(restaurant.version) ? restaurant.version : 0;
  // Keep legacy ownership lookup until a profile explicitly selects zones.
  // Materialising concurrent, not-yet-committed inserts could retain orphan IDs
  // when the losing insertion is compensated below.
  const refs = Array.isArray(restaurant.deliveryZoneIds)
    ? {deliveryZoneIds:[...new Set([...restaurant.deliveryZoneIds,item.id])]}
    : {};
  try {
    const result = await db.collection<any>("restaurants").updateOne(
      {id:restaurantId, ...versionFilter(expectedVersion)},
      {$set:{...refs,version:expectedVersion+1,updatedAt:new Date()},
       $push:{audit:{$each:[audit(user,"DELIVERY_ZONE_CREATED",expectedVersion+1)],$slice:-100}}} as any,
    );
    if (result.matchedCount !== 1) fail("CONCURRENT_MODIFICATION","Version modifiée, rechargez le restaurant");
  } catch (error) {
    await db.collection("delivery_zones").deleteOne({id:item.id});
    throw error;
  }
  return view(item);
}
export async function updateDeliveryZone(db:Db,user:Staff,idRaw:unknown,expectedRaw:unknown,input:any){
  if(user.role!=="ADMIN") fail("FORBIDDEN","Droits insuffisants"); const zid=id(idRaw,"id"); const current=await db.collection<any>("delivery_zones").findOne({id:zid}); if(!current) fail("ZONE_NOT_FOUND","Zone introuvable"); scope(user,current.restaurantId); if(!Number.isInteger(expectedRaw)||(expectedRaw as number)<0) fail("INVALID_INPUT","Version invalide"); const old=Number.isInteger(current.version)?current.version:0; if(expectedRaw!==old) fail("CONCURRENT_MODIFICATION","Version modifiée"); const value=normalizeZoneInput(input), next=old+1;
  const result=await db.collection<any>("delivery_zones").findOneAndUpdate({id:zid,...versionFilter(old)},{$set:{...value,version:next,updatedAt:new Date()},$push:{audit:{$each:[audit(user,"DELIVERY_ZONE_UPDATED",next)],$slice:-100}}} as any,{returnDocument:"after"});
  if(!result) fail("CONCURRENT_MODIFICATION","Version modifiée"); return view(result);
}
function distance(a:Point,b:Point){const p=Math.PI/180,dLat=(b.latitude-a.latitude)*p,dLon=(b.longitude-a.longitude)*p;const x=Math.sin(dLat/2)**2+Math.cos(a.latitude*p)*Math.cos(b.latitude*p)*Math.sin(dLon/2)**2;return 2*EARTH_M*Math.asin(Math.sqrt(Math.min(1,Math.max(0,x))));}
function insidePolygon(p:Point,poly:Point[]){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j], hit=((a.latitude>p.latitude)!==(b.latitude>p.latitude)) && p.longitude < (b.longitude-a.longitude)*(p.latitude-a.latitude)/(b.latitude-a.latitude)+a.longitude;if(hit)inside=!inside;if(onSegment(a,b,p))return true;}return inside;}
function active(hours:ZoneHours[],now:Date){if(!hours.length)return true;const day=now.getUTCDay(),minute=now.getUTCHours()*60+now.getUTCMinutes();return hours.some(h=>h.day===day&&minute>=h.startMinute&&minute<h.endMinute);}
export async function eligibility(db:Db,restaurantIdRaw:unknown,p:unknown,subtotal?:unknown,now=new Date()){
  const restaurantId=id(restaurantIdRaw,"restaurantId"); if(p===undefined||p===null) fail("DELIVERY_POINT_REQUIRED","Point de livraison requis"); const pointValue=normalizePoint(p); const subtotalValue=subtotal==null?undefined:subtotal; if(subtotalValue!==undefined&&(!Number.isInteger(subtotalValue)||(subtotalValue as number)<0)) fail("INVALID_INPUT","Sous-total invalide");
  const restaurant = await db.collection<any>("restaurants").findOne({id:restaurantId});
  if (!restaurant) fail("RESTAURANT_NOT_FOUND", "Restaurant introuvable");
  if (!isRestaurantOpen(restaurant, now)) fail("RESTAURANT_CLOSED", "Restaurant fermé");
  const zoneIds = await restaurantZoneIds(db, restaurant);
  const zones=await db.collection<any>("delivery_zones").find({id:{$in:zoneIds},enabled:true}).toArray(); const matched=zones.map(view).filter(z=>active(Array.isArray(z.hours)?z.hours:[],now)&& (z.shape==="CIRCLE"?distance(pointValue,z.center)<=z.radiusMeters+1e-7: z.shape==="POLYGON"&&insidePolygon(pointValue,z.polygon))).sort((a,b)=>(a.priority??0)-(b.priority??0)||String(a.id).localeCompare(String(b.id)));
  if(!matched.length) fail("OUT_OF_DELIVERY_ZONE","Point hors zone de livraison"); const z=matched[0]; if(subtotalValue!==undefined&&(subtotalValue as number)<z.minimumOrderXof) fail("MINIMUM_ORDER_NOT_MET","Minimum de commande non atteint"); return {zoneId:z.id,zoneName:z.name,zoneVersion:Number.isInteger(z.version)?z.version:0,deliveryFee:z.feeXof,minimumOrderXof:z.minimumOrderXof,estimatedMinutes:z.estimatedMinutes,demo:z.demo===true};
}
