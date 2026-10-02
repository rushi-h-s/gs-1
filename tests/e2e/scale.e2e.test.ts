// Load / scale: thousands of rows through the real import → reconcile → page-render path.
// Cross-checks the database round trip against the pure matcher, so truncation (Supabase's silent
// 1000-row cap), lost rows and duplicates all show up as a count mismatch.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startServer, sweepStale, makeClient, upload, reconcile, dbCount, dbGet, type Server } from './harness.ts'
import { parseGstr2bJson } from '../../lib/gstr2b-parser.ts'
import { reconcile as pureReconcile } from '../../lib/reconciliation.ts'

const N = Number(process.env.SCALE_ROWS ?? 3000) // > 1000 on purpose: crosses the API page size
const P = '2026-09'
let srv: Server
const cleanups: Array<() => Promise<void>> = []

before(async () => { await sweepStale(); srv = await startServer(3200, true) })
after(async () => { for (const c of cleanups) await c().catch(() => {}); await sweepStale().catch(() => {}); await srv?.stop() })

/** Deterministic dataset with every bucket represented. */
function dataset(n: number) {
  const gst = (i: number) => `27AAB${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i / 26) | 0) % 26)}${String(1000 + (i % 400)).padStart(4, '0')}A1Z5`
  const mk = (i: number, inv: string, tv: number, tax: number) =>
    ({ supplier_gstin: gst(i), invoice_number: inv, invoice_date: '2026-09-15', taxable_value: tv, cgst: tax / 2, sgst: tax / 2, igst: 0 })
  const pr: unknown[] = [], tb: unknown[] = []
  for (let i = 0; i < n; i++) {
    const tv = 1000 + i, tax = Math.round(tv * 0.18 * 100) / 100
    const k = i % 20
    pr.push(mk(i, `INV-${String(i).padStart(5, '0')}`, tv, tax))
    if (k === 0) continue                                   // books only
    if (k === 1) { tb.push(mk(i, `INV/${i}`, tv + 500, tax + 90)); continue } // mismatch
    if (k === 2) { tb.push(mk(i, `INV/${i}`, tv, tax + 5)); continue }        // probable (₹5 off)
    tb.push(mk(i, k === 3 ? `inv ${i}` : `INV/${i}`, tv, tax))                // matched, various spellings
  }
  for (let i = 0; i < Math.floor(n / 25); i++) tb.push(mk(i + 99999, `ONLY-${i}`, 777, 140)) // 2B only
  return { purchase_register: pr, gstr_2b: tb }
}

test(`${N} PR + ~${N} 2B rows: import, reconcile, and every count agrees with the pure matcher`, async () => {
  const c = await makeClient(srv.base)
  cleanups.push(c.cleanup)
  const data = dataset(N)
  const body = JSON.stringify(data)

  let t = performance.now()
  const up = await upload(srv.base, c.id, P, 'scale.json', body)
  const importMs = performance.now() - t
  assert.equal(up.status, 200, JSON.stringify(up.body))
  assert.equal(up.body.inserted, data.gstr_2b.length)
  assert.equal(up.body.pr_inserted, N)

  // what the DB holds must equal what we sent (catches truncation at 1000 rows)
  assert.deepEqual(await c.counts(P), { twoB: data.gstr_2b.length, pr: N, results: 0 })

  t = performance.now()
  const rc = await reconcile(srv.base, c.id, P)
  const reconcileMs = performance.now() - t
  assert.equal(rc.status, 200, JSON.stringify(rc.body))

  // Independent expectation: same parser + same pure matcher, no database involved.
  const entries = (side: unknown[], k: 'gstr_2b' | 'purchase_register') =>
    parseGstr2bJson({ gstr_2b: side }, { fallbackDate: '2026-09-01' }).entries
      .map((e, i) => ({ id: `${k}${i}`, norm_supplier_gstin: e.norm_supplier_gstin, norm_inv_no: e.norm_inv_no, taxable_value: e.taxable_value, cgst: e.cgst, sgst: e.sgst, igst: e.igst }))
  const expected = pureReconcile(entries(data.purchase_register, 'purchase_register'), entries(data.gstr_2b, 'gstr_2b'))
  const expCounts = expected.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {} as Record<string, number>)

  assert.deepEqual(rc.body.counts, expCounts, 'server buckets differ from the pure matcher on identical data')
  assert.equal(rc.body.total, expected.length)
  assert.ok(Object.keys(expCounts).length === 5, `dataset should exercise all 5 buckets, got ${Object.keys(expCounts)}`)

  // stored result rows: complete, no duplicates (this is the >1000 pagination check)
  assert.equal(await dbCount('match_results', `client_id=eq.${c.id}`), expected.length)
  const rows = await dbGet<any>(`match_results?client_id=eq.${c.id}&select=pr_entry_id,gstr2b_entry_id`)
  assert.equal(rows.length, expected.length)
  assert.equal(new Set(rows.map(r => `${r.pr_entry_id}:${r.gstr2b_entry_id}`)).size, expected.length)

  // re-run on the big set: still identical, not doubled
  const again = await reconcile(srv.base, c.id, P)
  assert.deepEqual(again.body.counts, expCounts)
  assert.equal(await dbCount('match_results', `client_id=eq.${c.id}`), expected.length)

  // the review page must render all of it (it reads results through the paged loader)
  t = performance.now()
  const page = await fetch(`${srv.base}/clients/${c.id}/reconciliation?period=${P}`)
  const pageMs = performance.now() - t
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.ok(html.includes(String(expected.length)), 'review page should show the full result total, not a 1000-row truncation')

  console.log(`scale N=${N}: import ${importMs.toFixed(0)}ms, reconcile ${reconcileMs.toFixed(0)}ms, page ${pageMs.toFixed(0)}ms`)
  assert.ok(importMs < 120_000, `import too slow: ${importMs}`)
  assert.ok(reconcileMs < 90_000, `reconcile too slow: ${reconcileMs}`)
  assert.ok(pageMs < 30_000, `page too slow: ${pageMs}`)
})

test('ageing across periods: a break open in two periods counts 2; same-period re-runs do not inflate', async () => {
  const c = await makeClient(srv.base)
  cleanups.push(c.cleanup)
  const row = { supplier_gstin: '27AABCU9603R1ZX', invoice_number: 'AGE/1', invoice_date: '2026-09-02', taxable_value: 100, cgst: 9, sgst: 9 }
  const books = (period: string) => upload(srv.base, c.id, period, 'b.json', JSON.stringify({ purchase_register: [row], gstr_2b: [{ ...row, invoice_number: 'OTHER/9' }] }))

  for (const period of ['2026-08', '2026-09']) {
    assert.equal((await books(period)).status, 200)
    assert.equal((await reconcile(srv.base, c.id, period)).status, 200)
    assert.equal((await reconcile(srv.base, c.id, period)).status, 200) // same-period re-run
  }
  const [h] = await dbGet<any>(`break_history?client_id=eq.${c.id}&norm_inv_no=eq.AGE1&select=periods_open,first_seen_period,last_seen_period,resolved_at`)
  assert.deepEqual(h, { periods_open: 2, first_seen_period: '2026-08', last_seen_period: '2026-09', resolved_at: null })
})
