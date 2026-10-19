#!/usr/bin/env node
/** Sauvegarde logique locale. Arrêter l'API et les écritures avant utilisation. */
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rm, stat, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url));
const { MongoClient, BSON } = require('mongodb');
const { EJSON } = BSON;
const FORMAT = 'delifast-local-logical-v1';
const MAX_BYTES = 100 * 1024 * 1024;
const excluded = new Set(['staff_sessions', 'sessions']);
function digest(text) { return createHash('sha256').update(text).digest('hex'); }
function permittedName(name) {
  return typeof name === 'string' && name.length > 0 && !name.startsWith('system.') && !name.includes('$') && !name.includes('\0');
}
function guard({ offline }) {
  if (process.env.NODE_ENV === 'production') throw new Error('Cet outil est réservé à la démonstration locale, pas à la production.');
  if (!offline) throw new Error('Arrêter toutes les écritures puis fournir --offline. Cette copie logique n’est pas un snapshot transactionnel.');
}
async function open(uri) {
  if (!uri) throw new Error('MONGODB_URI est obligatoire et doit inclure le nom de la base.');
  const parsed = new URL(uri);
  if (!parsed.pathname || parsed.pathname === '/' || ['admin', 'local', 'config'].includes(parsed.pathname.slice(1))) throw new Error('Une base applicative explicite est obligatoire.');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  return client;
}
export async function backup({ uri, file, offline = false }) {
  guard({ offline });
  const client = await open(uri);
  try {
    const db = client.db();
    const collections = [];
    for (const info of await db.listCollections({}, { nameOnly: false }).toArray()) {
      if (!permittedName(info.name) || excluded.has(info.name)) continue;
      if (info.type !== 'collection') throw new Error('Les vues ne sont pas prises en charge par cet outil local.');
      const collection = db.collection(info.name);
      const documents = await collection.find({}).toArray();
      const indexes = (await collection.indexes()).filter(index => index.name !== '_id_').map(({ key, name, unique, sparse, expireAfterSeconds, partialFilterExpression, collation }) => ({
        key, name, ...(unique !== undefined && { unique }), ...(sparse !== undefined && { sparse }),
        ...(expireAfterSeconds !== undefined && { expireAfterSeconds }), ...(partialFilterExpression && { partialFilterExpression }), ...(collation && { collation }),
      }));
      collections.push({ name: info.name, documents, indexes });
    }
    const payload = EJSON.stringify({ collections }, { relaxed: false });
    const envelope = JSON.stringify({ format: FORMAT, createdAt: new Date().toISOString(), sha256: digest(payload), payload });
    if (Buffer.byteLength(envelope) > MAX_BYTES) throw new Error('Archive trop volumineuse pour cet outil local (100 Mio maximum).');
    const target = resolve(file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // Ne jamais écraser une sauvegarde existante par erreur.
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, envelope + '\n', { mode: 0o600, flag: 'wx' });
      // link est atomique et refuse une destination déjà existante, contrairement à rename.
      const { link } = await import('node:fs/promises');
      await link(temporary, target);
    } finally { await rm(temporary, { force: true }); }
    return { collections: collections.length, documents: collections.reduce((sum, item) => sum + item.documents.length, 0) };
  } finally { await client.close(); }
}
export async function restore({ uri, file, offline = false }) {
  guard({ offline });
  if ((await stat(file)).size > MAX_BYTES) throw new Error('Archive trop volumineuse.');
  const envelope = JSON.parse(await readFile(file, 'utf8'));
  if (envelope.format !== FORMAT || typeof envelope.payload !== 'string' || digest(envelope.payload) !== envelope.sha256) throw new Error('Format ou somme de contrôle de sauvegarde invalide.');
  const { collections } = EJSON.parse(envelope.payload);
  if (!Array.isArray(collections) || new Set(collections.map(c => c.name)).size !== collections.length) throw new Error('Collections de sauvegarde invalides.');
  for (const item of collections) {
    if (!permittedName(item.name) || excluded.has(item.name) || !Array.isArray(item.documents) || !Array.isArray(item.indexes)) throw new Error('Collection de sauvegarde invalide.');
  }
  const client = await open(uri);
  try {
    const db = client.db();
    // Même une collection vide indique une base déjà initialisée : refus sans aucune suppression.
    if ((await db.listCollections().toArray()).length > 0) throw new Error('Restauration refusée : la base cible doit être entièrement vierge. Aucune donnée existante ne sera écrasée.');
    for (const item of collections) {
      const collection = await db.createCollection(item.name);
      if (item.documents.length) await collection.insertMany(item.documents, { ordered: true });
      for (const { key, ...options } of item.indexes) await collection.createIndex(key, options);
    }
    return { collections: collections.length, documents: collections.reduce((sum, item) => sum + item.documents.length, 0) };
  } finally { await client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , command, file, ...flags] = process.argv;
  try {
    if (!['backup', 'restore'].includes(command) || !file || flags.some(flag => flag !== '--offline')) throw new Error('Usage : MONGODB_URI=mongodb://127.0.0.1:27017/base node scripts/delifast-backup.mjs backup|restore fichier.json --offline');
    const result = await ({ backup, restore }[command])({ uri: process.env.MONGODB_URI, file, offline: flags.includes('--offline') });
    console.log(`OK — ${command} : ${result.collections} collections, ${result.documents} documents. Sessions exclues ; se reconnecter après restauration.`);
  } catch (error) { console.error(`Échec : ${error.message}`); process.exitCode = 1; }
}
