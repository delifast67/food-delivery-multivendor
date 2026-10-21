#!/usr/bin/env node
// Base temporaire uniquement. Aucun appel API métier, paiement, SMS ou service externe.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../delifast-api/package.json', import.meta.url))
const { MongoClient } = require('mongodb')
const source = fileURLToPath(new URL('../delifast-api/src/dev-db-replset.ts', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'delifast-dev-rs-'))
const uri = 'mongodb://127.0.0.1:27018/delifast?replicaSet=delifast-dev-rs'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let child, exited, client
async function start() {
  let logs = ''
  child = spawn(process.execPath, ['--import', require.resolve('tsx'), source], {
    cwd: directory,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  exited = once(child, 'exit')
  child.stdout.on('data', value => { logs += value })
  child.stderr.on('data', value => { logs += value })
  for (let i = 0; i < 400; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Replica set arrêté : ${logs}`)
    if (logs.includes('MongoDB replica set local prêt')) {
      client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 5000 })
      return
    }
    await wait(150)
  }
  throw new Error(`Replica set non prêt : ${logs}`)
}
async function stop() {
  await client?.close(); client = undefined
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
    try {
      const [code, signal] = await exited
      assert.equal(code, 0, `Arrêt non propre : ${signal}`)
    } finally { clearTimeout(timeout) }
  }
}
try {
  await start()
  const hello = await client.db('admin').command({ hello: 1 })
  assert.equal(hello.setName, 'delifast-dev-rs')
  assert.equal(hello.isWritablePrimary, true)
  assert.ok(hello.hosts.every(host => host.startsWith('127.0.0.1:')))
  assert.equal(await client.db().collection('_local_transaction_probe').countDocuments(), 0)
  await client.db().collection('persistence_probe').insertOne({ marker: 'synthetic-only' }, { writeConcern: { w: 'majority' } })
  await stop()
  console.log('OK — vrai replica set primaire sur loopback, transaction de démarrage annulée, arrêt propre')
  await start()
  assert.equal(await client.db().collection('persistence_probe').countDocuments({ marker: 'synthetic-only' }), 1)
  assert.equal(await client.db().collection('_local_transaction_probe').countDocuments(), 0)
  console.log('OK — redémarrage avec les mêmes données temporaires : persistance conservée')
} finally {
  try { await stop() } finally { await rm(directory, { recursive: true, force: true }) }
}
