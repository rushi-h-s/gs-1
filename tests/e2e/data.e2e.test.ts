// End-to-end: real app + real Supabase, using throw-away ZZ_E2E_* clients that are always deleted.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  startServer, sweepStale, makeClient, upload, reconcile, dbGet, dbWrite, dbCount, type Server,
} from './harness.ts'

const SAMPLES = 'D:/git/gst 2b'
const ACME = `${SAMPLES}/Acme_Bulk_Reconciliation_Test_Data_September_2026.json`
const P = '2026-09'
const haveSamples = fs.existsSync(ACME)

let srv: Server
const toClean: Array<() => Promise<void>> = []
const fresh = async (gstin?: string) => { const c = await makeClient(srv.base, gstin); toClean.push(c.cleanup); return c }

before(async () => { await sweepStale(); srv = await startServer(3200, true) })
after(async () => { for (const c of toClean) await c().catch(() => {}); await sweepStale().catch(() => {}); await srv?.stop() })

const statusCounts = (b: Record<string, any>) => b.counts as Record<string, number>
const acme = () => fs.readFileSync(ACME)

test('GOLDEN: Acme file → exact buckets, and exactly the expected invoices are flagged', { skip: !haveSamples }, async () => {
  const c = await fresh()
  const up = await upload(srv.base, c.id, P, 'acme.json', acme())
  assert.equal(up.status, 200, JSON.stringify(up.body))
  assert.deepEqual([up.body.inserted, up.body.pr_inserted], [40, 39])

  const rc = await reconcile(srv.base, c.id, P)
  assert.equal(rc.status, 200, JSON.stringify(rc.body))
  assert.deepEqual(statusCounts(rc.body), { MATCHED: 35, MISMATCH: 2, BOOKS_ONLY: 2, TWOB_ONLY: 3 })
  assert.deepEqual(rc.body.inputs, { purchase_register: 39, gstr2b: 40 })

  const bad = await dbGet<any>(`match_results?client_id=eq.${c.id}&status=neq.MATCHED&select=status,purchase_register_entries(inv_no),gstr2b_entries(inv_no)`)
  const flagged = bad.map(r => `${r.status}:${(r.purchase_register_entries ?? r.gstr2b_entries).inv_no}`).sort()
  assert.deepEqual(flagged, [
    'BOOKS_ONLY:VND/2026-27/1012', 'BOOKS_ONLY:VND/2026-27/2037',
    'MISMATCH:VND/2026-27/1004', 'MISMATCH:VND/2026-27/1008',
    'TWOB_ONLY:VND/2026-27/1012', 'TWOB_ONLY:VND/2026-27/1021', 'TWOB_ONLY:VND/2026-27/2038',
  ])
})

test('IDEMPOTENT: re-import + re-reconcile twice leaves identical, un-duplicated data', { skip: !haveSamples }, async () => {
  const c = await fresh()
  await upload(srv.base, c.id, P, 'acme.json', acme())
  const first = await reconcile(srv.base, c.id, P)
  for (let i = 0; i < 2; i++) {
    assert.equal((await upload(srv.base, c.id, P, 'acme.json', acme())).status, 200)
    const again = await reconcile(srv.base, c.id, P)
    assert.deepEqual(statusCounts(again.body), statusCounts(first.body))
    assert.deepEqual(await c.counts(P), { twoB: 40, pr: 39, results: 42 })
  }
  const history = await dbGet<any>(`break_history?client_id=eq.${c.id}&select=periods_open`)
  assert.ok(history.length > 0 && history.every(h => h.periods_open === 1), 'ageing must not inflate on same-period re-runs')
})

test('REVIEW DECISIONS survive a re-run when nothing changed', { skip: !haveSamples }, async () => {
  const c = await fresh()
  await upload(srv.base, c.id, P, 'acme.json', acme())
  await reconcile(srv.base, c.id, P)
  const [target] = await dbGet<any>(`match_results?client_id=eq.${c.id}&status=eq.MISMATCH&select=id,pr_entry_id,gstr2b_entry_id&limit=1`)
  await dbWrite('PATCH', `match_results?id=eq.${target.id}`, { user_status: 'accepted', resolution_reason: 'rounding', resolution_note: 'e2e' })
  assert.equal((await reconcile(srv.base, c.id, P)).status, 200)
  const [after] = await dbGet<any>(`match_results?client_id=eq.${c.id}&pr_entry_id=eq.${target.pr_entry_id}&gstr2b_entry_id=eq.${target.gstr2b_entry_id}&select=user_status,resolution_reason`)
  assert.deepEqual(after, { user_status: 'accepted', resolution_reason: 'rounding' })
})

test('LOCKED period blocks import and reconcile, and unlocks cleanly', { skip: !haveSamples }, async () => {
  const c = await fresh()
  await upload(srv.base, c.id, P, 'acme.json', acme())
  await reconcile(srv.base, c.id, P)
  const [{ org_id }] = await dbGet<any>(`clients?id=eq.${c.id}&select=org_id`)
  await dbWrite('POST', 'locked_periods', { org_id, client_id: c.id, period: P })
  const before = await c.counts(P)
  assert.equal((await reconcile(srv.base, c.id, P)).status, 409)
  assert.equal((await upload(srv.base, c.id, P, 'acme.json', acme())).status, 409)
  assert.deepEqual(await c.counts(P), before, 'a blocked write must change nothing')
  await dbWrite('DELETE', `locked_periods?client_id=eq.${c.id}`)
  assert.equal((await reconcile(srv.base, c.id, P)).status, 200)
})

test('BAD INPUT matrix: precise 4xx, never 5xx, never changes stored data', { skip: !haveSamples }, async () => {
  const c = await fresh()
  await upload(srv.base, c.id, P, 'acme.json', acme())
  const baseline = await c.counts(P)

  const html = '<html><body>Not a GST file</body></html>'
  const cases: Array<[string, () => Promise<{ status: number }>, number]> = [
    ['invalid json', () => upload(srv.base, c.id, P, 'x.json', '{not json'), 400],
    ['json without rows', () => upload(srv.base, c.id, P, 'x.json', '{"hello":1}'), 400],
    ['empty object', () => upload(srv.base, c.id, P, 'x.json', '{}'), 400],
    ['json array of junk', () => upload(srv.base, c.id, P, 'x.json', '[1,2,3,null,"a"]'), 400],
    ['empty file', () => upload(srv.base, c.id, P, 'x.json', ''), 400],
    ['html named .json', () => upload(srv.base, c.id, P, 'x.json', html), 400],
    ['garbage bytes as .xlsx', () => upload(srv.base, c.id, P, 'x.xlsx', Buffer.from(Array.from({ length: 500 }, (_, i) => (i * 37) % 256))), 400],
    ['pdf uploaded to the 2B endpoint', () => upload(srv.base, c.id, P, 'x.pdf', '%PDF-1.4 fake'), 400],
    ['csv without the needed columns', () => upload(srv.base, c.id, P, 'x.csv', 'a,b\n1,2\n', 'text/csv'), 400],
    ['period in wrong format', () => upload(srv.base, c.id, 'Sept-2026', 'x.json', acme()), 400],
    ['period out of range', () => upload(srv.base, c.id, '2026-13', 'x.json', acme()), 400],
    ['unknown client', () => upload(srv.base, '00000000-0000-4000-8000-000000000000', P, 'x.json', acme()), 404],
    ['client id not a uuid', () => upload(srv.base, 'not-a-uuid', P, 'x.json', acme()), 404],
    ['over the size limit', () => upload(srv.base, c.id, P, 'big.json', Buffer.alloc(16 * 1024 * 1024, 32)), 413],
  ]
  for (const [name, run, want] of cases) {
    const got = (await run()).status
    assert.equal(got, want, `${name}: expected ${want}, got ${got}`)
  }
  assert.deepEqual(await c.counts(P), baseline, 'rejected uploads must leave the period untouched')

  // reconcile request validation
  const post = (body: BodyInit | undefined, type = 'application/json') =>
    fetch(`${srv.base}/api/reconcile`, { method: 'POST', headers: { 'content-type': type }, body })
  assert.equal((await post('{')).status, 400)
  assert.equal((await post('{}')).status, 400)
  assert.equal((await post(undefined)).status, 400)
  assert.equal((await post(JSON.stringify({ client_id: c.id, period: '2031-01' }))).status, 400) // no data for that period
  assert.equal((await reconcile(srv.base, c.id, P)).status, 200, 'still healthy after all the abuse')
})

test('ATOMIC: a bad upload after a good one never wipes the good data', { skip: !haveSamples }, async () => {
  const c = await fresh()
  await upload(srv.base, c.id, P, 'acme.json', acme())
  const good = await c.counts(P)
  const bad = JSON.stringify({ gstr_2b: [{ supplier_gstin: 'X', invoice_number: '' }] })
  assert.equal((await upload(srv.base, c.id, P, 'bad.json', bad)).status, 400)
  assert.deepEqual(await c.counts(P), good)
})

test('ROW-LEVEL problems become warnings, good rows still import', async () => {
  const c = await fresh()
  const rows = [
    { supplier_gstin: '27AABCU9603R1ZX', invoice_number: 'OK/1', invoice_date: '2026-09-02', taxable_value: 100, cgst: 9, sgst: 9 },
    { supplier_gstin: '27AABCU9603R1ZX', invoice_number: 'BADDATE/2', invoice_date: 'someday', taxable_value: '₹1,000.50', cgst: '90', sgst: '90' },
    { supplier_gstin: '', invoice_number: 'NOGSTIN/3', taxable_value: 5 },
  ]
  const up = await upload(srv.base, c.id, P, 'mixed.json', JSON.stringify({ gstr_2b: rows }))
  assert.equal(up.status, 200, JSON.stringify(up.body))
  assert.equal(up.body.inserted, 2)
  assert.ok(up.body.warnings.length >= 2)
  const saved = await dbGet<any>(`gstr2b_entries?client_id=eq.${c.id}&select=inv_no,inv_date,taxable_value&order=inv_no`)
  assert.deepEqual(saved.map(s => [s.inv_no, s.inv_date, Number(s.taxable_value)]), [['BADDATE/2', '2026-09-01', 1000.5], ['OK/1', '2026-09-02', 100]])
})

test('SAMPLE FILES: every file in D:/git/gst 2b is imported or refused with a reason — never a 5xx', { skip: !haveSamples }, async () => {
  const report: string[] = []
  for (const f of fs.readdirSync(SAMPLES).filter(n => /\.(json|xlsx)$/i.test(n))) {
    const c = await makeClient(srv.base, '29AABCN7824Q1Z6') // NovaByte, so multi-company workbooks have a matching company
    try {
    const res = await upload(srv.base, c.id, P, f, fs.readFileSync(`${SAMPLES}/${f}`))
    assert.ok(res.status === 200 || res.status === 400, `${f}: HTTP ${res.status} ${JSON.stringify(res.body)}`)
    if (res.status === 200) {
      assert.ok(res.body.inserted > 0, `${f}: reported success with 0 rows`)
      assert.equal(await dbCount('gstr2b_entries', `client_id=eq.${c.id}`), res.body.inserted, `${f}: reported count != stored count`)
      const rc = await reconcile(srv.base, c.id, P)
      assert.equal(rc.status, 200, `${f}: reconcile ${JSON.stringify(rc.body)}`)
    } else assert.ok(typeof res.body.error === 'string' && res.body.error.length > 10, `${f}: refusal without a useful message`)
    report.push(`${res.status} ${f}`)
    } finally { await c.cleanup() }
  }
  console.log(report.join('\n'))
})

test('CONCURRENCY: simultaneous reconciles leave exactly one coherent result set', { skip: !haveSamples }, async () => {
  const c = await fresh()
  await upload(srv.base, c.id, P, 'acme.json', acme())
  const runs = await Promise.all(Array.from({ length: 4 }, () => reconcile(srv.base, c.id, P)))
  assert.ok(runs.every(r => r.status === 200), JSON.stringify(runs.map(r => r.body)))
  const rows = await dbGet<any>(`match_results?client_id=eq.${c.id}&period=eq.${P}&select=pr_entry_id,gstr2b_entry_id,run_id`)
  assert.equal(rows.length, 42, `expected 42 results, found ${rows.length} (duplicates or losses under concurrency)`)
  assert.equal(new Set(rows.map(r => `${r.pr_entry_id}:${r.gstr2b_entry_id}`)).size, 42)
})

test('CONCURRENCY: simultaneous imports of the same period do not multiply rows', { skip: !haveSamples }, async () => {
  const c = await fresh()
  const ups = await Promise.all(Array.from({ length: 3 }, () => upload(srv.base, c.id, P, 'acme.json', acme())))
  assert.ok(ups.every(u => u.status === 200 || u.status === 409), JSON.stringify(ups.map(u => u.body)))
  const n = await c.counts(P)
  assert.deepEqual([n.twoB, n.pr], [40, 39], `rows multiplied under concurrent imports: ${JSON.stringify(n)}`)
})
