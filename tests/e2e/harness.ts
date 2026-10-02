// Shared helpers for end-to-end tests: boots the real app, talks to the real Supabase project,
// and guarantees cleanup of everything it creates (all test clients are named ZZ_E2E_*).
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../..')

export function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const l of fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^([A-Z_]+)\s*=\s*(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return env
}
export const env = loadEnv()

export interface Server { base: string; stop: () => Promise<void> }

/** Start `next dev` on a port; bypass=true runs it with the dev auth bypass (data suites). */
export async function startServer(port: number, bypass: boolean): Promise<Server> {
  const child: ChildProcess = spawn(process.execPath, [path.join(ROOT, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(port)], {
    cwd: ROOT,
    env: { ...process.env, ...(bypass ? { DEV_AUTH_BYPASS: 'true' } : { DEV_AUTH_BYPASS: '' }), NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'ignore',
  })
  const base = `http://localhost:${port}`
  const stop = async () => {
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
    await new Promise(r => setTimeout(r, 1500))
  }
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${base}/login`, { redirect: 'manual' })).status < 500) return { base, stop } } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  await stop()
  throw new Error(`next dev did not start on :${port}`)
}

// ── direct DB access (service role) for set-up, assertions and cleanup ────────
const REST = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`
const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json' }

export async function dbGet<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += 1000) {
    const r = await fetch(REST + query, { headers: { ...H, Range: `${from}-${from + 999}` } })
    if (!r.ok) throw new Error(`dbGet ${query}: ${r.status} ${await r.text()}`)
    const page = (await r.json()) as T[]
    out.push(...page)
    if (page.length < 1000) return out
  }
}
export async function dbCount(table: string, filter: string): Promise<number> {
  const r = await fetch(`${REST}${table}?${filter}&select=id`, { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } })
  return Number(r.headers.get('content-range')?.split('/')[1] ?? NaN)
}
export async function dbWrite(method: 'POST' | 'PATCH' | 'DELETE', query: string, body?: unknown) {
  const r = await fetch(REST + query, { method, headers: { ...H, Prefer: 'return=minimal' }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (!r.ok) throw new Error(`dbWrite ${method} ${query}: ${r.status} ${await r.text()}`)
}

const CHILD_TABLES = ['match_results', 'break_history', 'recon_run', 'locked_periods', 'period_snapshots', 'ledger_allocations', 'extraction_jobs', 'gstr2b_entries', 'purchase_register_entries']

export async function deleteClient(id: string) {
  for (const t of CHILD_TABLES) await dbWrite('DELETE', `${t}?client_id=eq.${id}`)
  await dbWrite('DELETE', `clients?id=eq.${id}`)
}
/** Remove leftovers from any earlier crashed run. */
export async function sweepStale() {
  for (const c of await dbGet<{ id: string }>('clients?name=like.ZZ_E2E_*&select=id')) await deleteClient(c.id)
}

let seq = 0
/** Create a throw-away client through the real API; returns helpers bound to it. */
/** A well-formed GSTIN that no real client has (clients.gstin is globally unique in the DB). */
let gseq = Math.floor(Math.random() * 9000)
export const uniqueGstin = () => `27ZZEEE${String(1000 + (gseq++ % 9000))}E1Z5`

export async function makeClient(base: string, gstin: string = uniqueGstin()) {
  const name = `ZZ_E2E_${Date.now()}_${seq++}`
  const r = await fetch(`${base}/api/clients`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, gstin }) })
  if (r.status !== 201) throw new Error(`could not create test client: ${r.status} ${await r.text()}`)
  const { id } = (await r.json()) as { id: string }
  return {
    id,
    cleanup: () => deleteClient(id),
    counts: async (period: string) => ({
      twoB: await dbCount('gstr2b_entries', `client_id=eq.${id}&period=eq.${period}`),
      pr: await dbCount('purchase_register_entries', `client_id=eq.${id}&period=eq.${period}`),
      results: await dbCount('match_results', `client_id=eq.${id}&period=eq.${period}`),
    }),
  }
}

export async function upload(base: string, clientId: string, period: string, name: string, content: string | Buffer | Uint8Array, type = 'application/json') {
  const fd = new FormData()
  fd.set('file', new File([content as BlobPart], name, { type }))
  fd.set('client_id', clientId)
  fd.set('period', period)
  const res = await fetch(`${base}/api/gstr2b/upload`, { method: 'POST', body: fd })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }
}

export async function reconcile(base: string, clientId: string, period: string) {
  const res = await fetch(`${base}/api/reconcile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: clientId, period }) })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }
}
