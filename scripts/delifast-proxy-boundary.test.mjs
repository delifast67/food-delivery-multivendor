import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);
const ts = require('../enatega-multivendor-web/node_modules/typescript');
const routes = [
  ['web', 'enatega-multivendor-web/app/api/delifast/graphql/route.ts'],
  ['admin', 'enatega-multivendor-admin/app/api/delifast/graphql/route.local.ts'],
];

function loadRoute(path, fetch, target = 'http://127.0.0.1:4000/graphql') {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  class NextResponse extends Response {
    static json(body, init) {
      return new NextResponse(JSON.stringify(body), {
        ...init, headers: { ...init?.headers, 'content-type': 'application/json' },
      });
    }
  }
  const exports = {};
  const context = vm.createContext({
    exports, fetch, TextEncoder, TextDecoder, AbortSignal,
    process: { env: {
      DELIFAST_LOCAL_MODE: 'true',
      DELIFAST_API_URL: target,
    } },
    require(name) {
      assert.equal(name, 'next/server', 'Only the Next response boundary may be imported');
      return { NextResponse };
    },
  });
  vm.runInContext(compiled, context, { filename: path });
  return exports.POST;
}

function request() {
  return new Request('http://127.0.0.1/api/delifast/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local-test-only' },
    body: JSON.stringify({ query: '{ restaurants { id } }' }),
  });
}

for (const [name, path] of routes) {
  test(`${name}: ordinary local GraphQL response and authentication are preserved`, async () => {
    let calls = 0;
    const post = loadRoute(path, async (url, init) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:4000/graphql');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.authorization, 'Bearer local-test-only');
      assert.equal(init.cache, 'no-store');
      assert.deepEqual(JSON.parse(init.body), { query: '{ restaurants { id } }' });
      return Response.json({ data: { restaurants: [] } });
    });
    const response = await post(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { restaurants: [] } });
    assert.equal(calls, 1);
  });

  test(`${name}: HTTP 301/302/303/307/308 never reach a redirected destination`, async (t) => {
    let status = 301;
    let upstreamCalls = 0;
    let destinationCalls = 0;
    const server = createServer((req, res) => {
      req.resume();
      if (req.url === '/graphql') {
        upstreamCalls++;
        res.writeHead(status, { location: '/unexpected-destination' });
        res.end();
      } else {
        destinationCalls++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"data":{"unexpectedDestination":true}}');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }));
    const target = `http://127.0.0.1:${server.address().port}/graphql`;
    const post = loadRoute(path, globalThis.fetch, target);
    for (status of [301, 302, 303, 307, 308]) {
      const response = await post(request());
      assert.equal(response.status, 502, `Redirect ${status} must fail closed`);
      assert.equal(destinationCalls, 0, `Redirect ${status} must not be followed`);
      const body = await response.text();
      assert.ok(!body.includes('local-test-only'), 'Errors must not expose authorization');
      assert.ok(!body.includes('unexpectedDestination'), 'Errors must not expose upstream content');
    }
    assert.equal(upstreamCalls, 5);
  });

  test(`${name}: network failure returns an unavailable response without echoing errors`, async () => {
    const post = loadRoute(path, async () => { throw new Error('private-upstream-detail'); });
    const response = await post(request());
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes('private-upstream-detail'));
  });
}
