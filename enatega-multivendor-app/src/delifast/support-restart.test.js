'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const run = promisify(execFile)
const appRoot = path.resolve(__dirname, '../..')
const child = `
'use strict';
(async () => {
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createController, SUPPORT_ATTEMPT_KEY } = require('./src/delifast/controller.js')
const { createSecureStorage } = require('./src/delifast/secure-storage.js')

const [mode, nativeDir, serverFile, token, customerId] = process.argv.slice(1)
const keyFile = key => path.join(nativeDir, Buffer.from(key).toString('base64url'))
const native = {
  async getItemAsync(key) {
    try { return await fs.readFile(keyFile(key), 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  },
  async setItemAsync(key, value) { await fs.writeFile(keyFile(key), value, 'utf8') },
  async deleteItemAsync(key) { try { await fs.unlink(keyFile(key)) } catch (error) { if (error.code !== 'ENOENT') throw error } }
}
const storage = createSecureStorage(native, () => \`${process.pid}-\${Date.now()}-\${Math.random().toString(36).slice(2)}\`)
const fingerprintSession = value => createHash('sha256').update(value).digest('hex')
const readServer = async () => { try { return JSON.parse(await fs.readFile(serverFile, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return { tickets: [], calls: 0 }; throw error } }
const writeServer = value => fs.writeFile(serverFile, JSON.stringify(value), 'utf8')
const api = {
  currentToken: null,
  setCustomerToken(value) { this.currentToken = value },
  async customerMe() { return { id: customerId, phone: '+22670000000' } },
  async customerAddresses() { return [] },
  async customerSupportTickets() { const server = await readServer(); return server.tickets.filter(ticket => ticket.customerId === customerId) },
  async createSupportTicket(input) {
    const server = await readServer()
    server.calls++
    let ticket = server.tickets.find(item => item.customerId === customerId && item.idempotencyKey === input.idempotencyKey)
    if (!ticket) {
      ticket = { id: \`fixture-ticket-\${input.idempotencyKey}\`, customerId, subject: input.subject, description: input.description, idempotencyKey: input.idempotencyKey }
      server.tickets.push(ticket)
    }
    await writeServer(server)
    if (mode === 'first') throw Object.assign(new Error('Réponse réseau perdue après écriture'), { kind: 'unavailable' })
    return ticket
  }
}
const controller = createController({ api, storage, fingerprintSession, random: () => 'restart-key-1234' })
await storage.setItem('delifast-customer-token', token)
assert.deepEqual(await controller.restoreCustomer(), { id: customerId, phone: '+22670000000' })
if (mode === 'first') {
  await assert.rejects(controller.createSupportTicket({ subject: 'Sujet fixture', description: 'Description fixture' }), /Réponse réseau perdue/)
  assert.ok(controller.getState().supportPending)
} else if (mode === 'retry') {
  await controller.loadSupportTickets()
  const recovered = await controller.retrySupportTicket()
  assert.equal(recovered.customerId, customerId)
} else if (mode === 'mismatch') {
  await assert.rejects(controller.loadSupportTickets(), /Ancienne session/)
}
})()
`

const tokenA = 'fixture-token-account-a-1234567890'
const tokenB = 'fixture-token-account-b-1234567890'
const fingerprintSession = token => createHash('sha256').update(token).digest('hex')

async function launch(mode, nativeDir, serverFile, token, customerId) {
  await run(process.execPath, ['-e', child, mode, nativeDir, serverFile, token, customerId], { cwd: appRoot })
}

async function nativeFiles(dir) {
  return (await fs.readdir(dir)).sort()
}
const supportPrefix = Buffer.from('delifast-support-attempt').toString('base64url')
const supportFiles = async dir => (await nativeFiles(dir)).filter(name => name.startsWith(supportPrefix))

test('support restart inter-processus : même clé/payload, idempotence et purge SecureStorage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delifast-support-restart-'))
  const nativeDir = path.join(root, 'native')
  const serverFile = path.join(root, 'server-fixture.json')
  await fs.mkdir(nativeDir)
  try {
    await launch('first', nativeDir, serverFile, tokenA, 'customer-a')
    const afterFirst = JSON.parse(await fs.readFile(serverFile, 'utf8'))
    assert.equal(afterFirst.tickets.length, 1)
    assert.equal(afterFirst.calls, 1)
    const first = afterFirst.tickets[0]
    assert.equal(typeof first.idempotencyKey, 'string')
    assert.deepEqual({ subject: first.subject, description: first.description }, { subject: 'Sujet fixture', description: 'Description fixture' })
    assert.ok((await supportFiles(nativeDir)).length >= 2, 'le manifeste et le fragment de tentative doivent être présents')

    await launch('retry', nativeDir, serverFile, tokenA, 'customer-a')
    const afterRetry = JSON.parse(await fs.readFile(serverFile, 'utf8'))
    assert.equal(afterRetry.tickets.length, 1)
    assert.equal(afterRetry.calls, 2)
    assert.deepEqual(afterRetry.tickets[0], first)
    assert.equal((await supportFiles(nativeDir)).length, 0, 'aucun manifeste ni fragment de tentative ne doit rester')

    await fs.writeFile(path.join(nativeDir, Buffer.from('delifast-customer-token').toString('base64url')), tokenB, 'utf8')
    await assert.rejects(launch('mismatch', nativeDir, serverFile, tokenB, 'customer-a'), /Ancienne session/)
    const afterSameAccountNewToken = JSON.parse(await fs.readFile(serverFile, 'utf8'))
    assert.equal(afterSameAccountNewToken.calls, 2)
    assert.equal((await supportFiles(nativeDir)).length, 0)

    await fs.writeFile(path.join(nativeDir, Buffer.from('delifast-customer-token').toString('base64url')), tokenB, 'utf8')
    await assert.rejects(launch('mismatch', nativeDir, serverFile, tokenB, 'customer-b'), /Ancienne session/)
    const afterOtherAccount = JSON.parse(await fs.readFile(serverFile, 'utf8'))
    assert.equal(afterOtherAccount.calls, 2)
    assert.equal(afterOtherAccount.tickets.length, 1)
    assert.equal((await supportFiles(nativeDir)).length, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

void fingerprintSession
