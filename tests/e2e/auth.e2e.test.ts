// Auth gate: with NO session, nothing except /login (and the secret-guarded webhook) may be reachable.
// Routes and pages are discovered from the file tree, so a newly added route is covered automatically.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer, type Server } from './harness.ts'

const APP = path.resolve(import.meta.dirname, '../../app')
const UUID = '00000000-0000-4000-8000-000000000000'
let srv: Server

before(async () => { srv = await startServer(3201, false) })
after(async () => { await srv?.stop() })

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
}
const toUrl = (file: string) =>
  '/' + path.relative(APP, path.dirname(file)).split(path.sep)
    .filter(seg => !/^\(.*\)$/.test(seg)) // (route-groups) are not part of the URL
    .map(seg => (/^\[.*\]$/.test(seg) ? UUID : seg)).join('/')

const files = walk(APP)
const routes = files.filter(f => /route\.ts$/.test(f))
const pages = files.filter(f => /page\.tsx$/.test(f))

test('discovery found the app (guards against an empty, vacuous pass)', () => {
  assert.ok(routes.length >= 10, `found ${routes.length} routes`)
  assert.ok(pages.length >= 5, `found ${pages.length} pages`)
})

for (const file of routes) {
  const url = toUrl(file)
  const methods = [...fs.readFileSync(file, 'utf8').matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(m => m[1])
  for (const method of methods) {
    test(`API ${method} ${url} refuses a signed-out caller`, async () => {
      const res = await fetch(srv.base + url, {
        method, redirect: 'manual',
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
      })
      if (url === '/api/email-inbound') {
        assert.ok([401, 503].includes(res.status), `webhook answered ${res.status}`) // no/invalid secret
        return
      }
      if (url === '/api/health') { // deliberately public, must expose nothing but ok / not ok
        assert.ok([200, 503].includes(res.status))
        assert.match(await res.text(), /^{"ok":(true|false)}$/)
        return
      }
      assert.equal(res.status, 401, `${method} ${url} answered ${res.status} without a session`)
      const text = await res.text()
      assert.ok(!/org_id|gstin|supplier/i.test(text), 'response must not leak data')
    })
  }
}

for (const file of pages) {
  const url = toUrl(file)
  if (url === '/login') continue
  test(`page ${url} redirects a signed-out visitor to /login`, async () => {
    const res = await fetch(srv.base + url, { redirect: 'manual' })
    assert.equal(res.status, 307)
    assert.match(res.headers.get('location') ?? '', /\/login/)
  })
}

test('/login itself is public and renders', async () => {
  const res = await fetch(srv.base + '/login')
  assert.equal(res.status, 200)
})

test('webhook rejects a wrong secret', async () => {
  const res = await fetch(srv.base + '/api/email-inbound', { method: 'POST', headers: { 'x-webhook-secret': 'wrong', 'content-type': 'application/json' }, body: '{}' })
  assert.ok([401, 503].includes(res.status))
})

test('a forged / junk session cookie is not accepted', async () => {
  for (const cookie of ['sb-access-token=abc', 'sb-eebtyqonsvzmyqczglhq-auth-token=garbage', 'sb-x-auth-token=' + 'A'.repeat(4000)]) {
    const res = await fetch(srv.base + '/api/clients', { headers: { cookie } })
    assert.equal(res.status, 401, `cookie ${cookie.slice(0, 30)}… was accepted`)
  }
})

test('no unauthenticated path leaks through odd URL forms', async () => {
  for (const p of ['//api/clients', '/api/clients/', '/API/clients', '/api/clients%2F', '/api/../api/clients', '/clients/../clients/new']) {
    const res = await fetch(srv.base + p, { redirect: 'manual' })
    assert.ok(res.status === 401 || res.status === 307 || res.status === 404 || res.status === 308, `${p} answered ${res.status}`)
  }
})
