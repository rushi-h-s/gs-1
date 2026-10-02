// Run: npm test   (Node's built-in runner; no extra dependencies)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { normalizeInvNo, parseDate, parseNum } from '../../lib/normalize.ts'
import { parseGstr2bJson, parseGstr2bExcel, parsePurchaseRegisterJson, ImportError } from '../../lib/gstr2b-parser.ts'
import { reconcile, type Entry } from '../../lib/reconciliation.ts'

const opts = { fallbackDate: '2026-09-01', clientGstin: '27AAPFU0939F1ZV' }

test('invoice number variants collapse to one key', () => {
  const keys = new Set(['INV-0042', 'INV/0042', 'INV.42', 'inv0042', ' INV 42 '].map(normalizeInvNo))
  assert.equal(keys.size, 1)
  assert.equal(normalizeInvNo('ACM/2026-27/0891'), 'ACM2026270891')
  assert.notEqual(normalizeInvNo('INV-10'), normalizeInvNo('INV-1'))
})

test('dates and numbers from real-world files', () => {
  assert.equal(parseDate('02-Aug-2026'), '2026-08-02')
  assert.equal(parseDate('15-09-2026'), '2026-09-15')
  assert.equal(parseDate('2026-09-02'), '2026-09-02')
  assert.equal(parseDate('31-02-2026'), null)
  assert.equal(parseDate(46000), '2025-12-09')
  assert.equal(parseNum('₹1,23,456.50'), 123456.5)
  assert.equal(parseNum('(500)'), -500)
  assert.equal(parseNum(''), 0)
})

test('flat gstr_2b + embedded purchase_register (Acme layout)', () => {
  const json = {
    purchase_register: [{ supplier_gstin: '19AABCV1008H1Z8', invoice_number: 'VND/1', invoice_date: '2026-09-21', taxable_value: 100, igst: 18 }],
    gstr_2b: [{ supplier_gstin: '19AABCV1008H1Z8', invoice_number: 'VND/1', invoice_date: '2026-09-21', taxable_value: 100, igst: 18 }],
  }
  assert.equal(parseGstr2bJson(json, opts).entries.length, 1)
  assert.equal(parsePurchaseRegisterJson(json, opts).entries.length, 1)
})

test('"records" with *_amount keys (synthetic layout)', () => {
  const r = parseGstr2bJson({ records: [{ supplier_gstin: '36AABCZ1234P1ZR', invoice_number: 'A/1', invoice_date: '2026-09-01', taxable_value: 150000, igst_amount: 27000, cgst_amount: 0, sgst_amount: 0 }] }, opts)
  assert.equal(r.entries[0].igst, 27000)
})

test('display-name headers and dd-Mon-yyyy dates (Textile layout)', () => {
  const r = parseGstr2bJson({ records: [{
    'GSTIN of Supplier': '24AAACS8020H1ZO', 'Invoice Number': 'SFT/26-27/0812', 'Invoice Date': '02-Aug-2026',
    'Invoice Type (Regular/Credit Note/Debit Note/Amendment)': 'Credit Note',
    'Taxable Value (₹)': 100000, 'IGST (₹)': 0, 'CGST (₹)': 9000, 'SGST (₹)': 9000,
  }] }, opts)
  const e = r.entries[0]
  assert.deepEqual([e.inv_date, e.cgst, e.sgst, e.doc_type], ['2026-08-02', 9000, 9000, 'credit_note'])
})

test('GST portal b2b layout', () => {
  const r = parseGstr2bJson({ data: { docdata: { b2b: [{ ctin: '27AABCU9603R1ZX', inv: [{ inum: 'X/1', dt: '15-09-2026', itms: [{ itm_det: { txval: 100, camt: 9, samt: 9 } }] }] }] } } }, opts)
  assert.deepEqual([r.entries[0].inv_date, r.entries[0].cgst], ['2026-09-15', 9])
})

test('multi-company file picks the client, errors if none match', () => {
  const row = { supplier_gstin: '27AABCU9603R1ZX', invoice_number: '1', invoice_date: '2026-09-01', taxable_value: 1 }
  const json = { companies: [{ gstin: '27AAPFU0939F1ZV', gstr_2b: [row] }, { gstin: '29AAAAA0000A1Z5', gstr_2b: [row, row] }] }
  assert.equal(parseGstr2bJson(json, opts).entries.length, 1)
  assert.throws(() => parseGstr2bJson(json, { ...opts, clientGstin: '33ZZZZZ9999Z1Z9' }), ImportError)
})

test('unparseable files fail loudly instead of importing 0 rows', () => {
  assert.throws(() => parseGstr2bJson({ hello: 'world' }, opts), ImportError)
  assert.throws(() => parseGstr2bJson({ records: [{ foo: 1 }] }, opts), ImportError)
  assert.throws(() => parseGstr2bJson({ test_cases: [{ supplier_gstin: 'x' }] }, opts), /one-sided/)
})

test('CSV through the Excel path', () => {
  const csv = 'Status,Supplier GSTIN,Invoice No,Taxable,CGST,SGST,IGST\nBOOKS_ONLY,27AAPFU0939F1ZV,ACM/1,122000,10980,10980,0\n'
  const r = parseGstr2bExcel(Buffer.from(csv), opts)
  assert.equal(r.entries[0].taxable_value, 122000)
})

const E = (id: string, g: string, inv: string, tv: number, cgst = 0, sgst = 0, igst = 0): Entry =>
  ({ id, norm_supplier_gstin: g, norm_inv_no: normalizeInvNo(inv), taxable_value: tv, cgst, sgst, igst })

test('reconcile: separators no longer split a match; buckets are right', () => {
  const pr = [E('p1', 'G1', 'INV-0042', 1000, 90, 90), E('p2', 'G1', 'INV-7', 1000, 90, 90), E('p3', 'G2', 'ZZ9', 500)]
  const tb = [E('t1', 'G1', 'INV/42', 1000, 90, 90), E('t2', 'G1', 'INV-8', 1000, 90, 90), E('t3', 'G9', 'Q1', 10)]
  const by = Object.fromEntries(reconcile(pr, tb).map(r => [r.pr_entry_id ?? r.gstr2b_entry_id, r.status]))
  assert.equal(by.p1, 'MATCHED')
  assert.equal(by.p2, 'PROBABLE') // INV-7 vs INV-8: one edit apart, same amounts
  assert.equal(by.p3, 'BOOKS_ONLY')
  assert.equal(by.t3, 'TWOB_ONLY')
})

test('reconcile: rupee tolerances (Acme 1004 / 1008 cases are exceptions, rounding is not)', () => {
  const pr = [E('a', 'G1', 'V1004', 68500, 0, 0, 12330), E('b', 'G1', 'V1008', 24500, 0, 0, 4410), E('c', 'G1', 'V9', 1000, 90, 90), E('d', 'G1', 'V5', 1000, 90, 90)]
  const tb = [E('a2', 'G1', 'V1004', 69500, 0, 0, 12510), E('b2', 'G1', 'V1008', 24500, 0, 0, 4590), E('c2', 'G1', 'V9', 1000.4, 90.3, 89.8), E('d2', 'G1', 'V5', 1000, 95, 90)]
  const by = Object.fromEntries(reconcile(pr, tb).map(r => [r.pr_entry_id, r.status]))
  assert.deepEqual(by, { a: 'MISMATCH', b: 'MISMATCH', c: 'MATCHED', d: 'PROBABLE' })
})

test('reconcile scales: 20k vs 20k rows in well under a few seconds', () => {
  const n = 20000
  const pr = Array.from({ length: n }, (_, i) => E(`p${i}`, `G${i % 500}`, `INV-${i}`, 1000 + i, 90, 90))
  const tb = Array.from({ length: n }, (_, i) => E(`t${i}`, `G${i % 500}`, i % 10 ? `INV/${i}` : `XX${i}`, 1000 + i, 90, 90))
  const t0 = performance.now()
  const res = reconcile(pr, tb)
  const ms = performance.now() - t0
  assert.ok(res.length >= n)
  assert.ok(ms < 5000, `took ${ms.toFixed(0)}ms`)
})

// Your own sample files, if present on this machine
const DIR = 'D:/git/gst 2b'
test('every GSTR-2B sample file in D:/git/gst 2b imports rows (or is rejected with a reason)', { skip: !fs.existsSync(DIR) }, () => {
  const rejectedOk = ['GST_Additional_40_Test_Cases.json', 'GST_Additional_40_Test_Cases_With_Business_GSTIN.json'] // one-sided, rejected by design
  for (const f of fs.readdirSync(DIR)) {
    const buf = fs.readFileSync(`${DIR}/${f}`)
    if (/\.json$/i.test(f)) {
      if (rejectedOk.includes(f)) { assert.throws(() => parseGstr2bJson(JSON.parse(buf.toString()), opts), ImportError, f); continue }
      const o = { ...opts, clientGstin: '27AAAAA0000A1Z5' }
      let n = 0
      try { n = parseGstr2bJson(JSON.parse(buf.toString()), o).entries.length } catch (e) {
        // multi-company file with a non-matching client is a legitimate, explained rejection
        assert.ok(e instanceof ImportError && /companies/.test(e.message), `${f}: ${(e as Error).message}`); continue
      }
      assert.ok(n > 0, `${f} imported ${n} rows`)
    } else if (/\.xlsx$/i.test(f)) {
      assert.ok(parseGstr2bExcel(buf, opts).entries.length > 0, f)
    }
  }
})
