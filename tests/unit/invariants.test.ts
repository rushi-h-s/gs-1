// Property-style tests: instead of fixed examples, generate thousands of random inputs from a
// seeded PRNG and assert rules that must ALWAYS hold. A failure prints the seed to reproduce it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeInvNo, normalizeGstin, parseDate, parseNum } from '../../lib/normalize.ts'
import { parseGstr2bJson, parseGstr2bExcel, parsePurchaseRegisterJson, ImportError } from '../../lib/gstr2b-parser.ts'
import { reconcile, type Entry } from '../../lib/reconciliation.ts'

const SEED = Number(process.env.SEED ?? 20260901)
function rng(seed: number) { // mulberry32
  let a = seed
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function pick<T>(r: () => number, xs: T[]): T { return xs[Math.floor(r() * xs.length)] }
const opts = { fallbackDate: '2026-09-01', clientGstin: '27AAPFU0939F1ZV' }
const NASTY = ['', ' ', '0', '00', '-', '/', 'INV-', 'ÀÉÎ', '日本語', '💥', '\u0000', '\n', 'null', 'NaN', '1e999', '(', ')', '₹', '  INV / 001  ', 'a'.repeat(5000)]

test('normalisers never throw, are idempotent, and ignore separators', () => {
  const r = rng(SEED)
  for (let i = 0; i < 5000; i++) {
    const s = r() < 0.3 ? pick(r, NASTY) : Array.from({ length: Math.floor(r() * 14) }, () => pick(r, ['A', 'b', '0', '7', '-', '/', '.', ' ', '_', 'Z', '9'])).join('')
    const n = normalizeInvNo(s)
    assert.equal(normalizeInvNo(n), n, `not idempotent for ${JSON.stringify(s)} (seed ${SEED})`)
    assert.match(n, /^[A-Z0-9]*$/)
    assert.equal(normalizeInvNo(s.replace(/[^A-Za-z0-9]/g, '/')), normalizeInvNo(s.replace(/[^A-Za-z0-9]/g, '-')))
    assert.equal(normalizeGstin(normalizeGstin(s)), normalizeGstin(s))
  }
})

test('parseNum / parseDate never throw and return sane types for any input', () => {
  const r = rng(SEED + 1)
  const weird: unknown[] = [null, undefined, NaN, Infinity, {}, [], [1], true, 0, -0, 1e308, '1,2,3', '--5', '₹ 1,00,000.50', '(0)', 45000.5, '2026-13-45', '31/12/2026', '29-02-2026', '29-Feb-2028', ...NASTY]
  for (let i = 0; i < 3000; i++) {
    const v = r() < 0.5 ? pick(r, weird) : String(Math.floor(r() * 1e6)) + pick(r, ['', '/', '-', '.', ' ', 'x'])
    const n = parseNum(v)
    assert.ok(Number.isFinite(n), `parseNum(${String(v)}) = ${n}`)
    const d = parseDate(v)
    assert.ok(d === null || /^\d{4}-\d{2}-\d{2}$/.test(d), `parseDate(${String(v)}) = ${d}`)
  }
  assert.equal(parseDate('29-02-2026'), null) // 2026 is not a leap year
  assert.equal(parseDate('29-02-2028'), '2028-02-29')
})

const E = (id: string, g: string, inv: string, tv: number, c: number, s: number, i: number): Entry =>
  ({ id, norm_supplier_gstin: g, norm_inv_no: normalizeInvNo(inv), taxable_value: tv, cgst: c, sgst: s, igst: i })

test('reconcile: conservation + no double use, over 300 random datasets incl. duplicates and blank keys', () => {
  const r = rng(SEED + 2)
  for (let round = 0; round < 300; round++) {
    const nPr = Math.floor(r() * 60), nTb = Math.floor(r() * 60)
    const gstins = ['G1', 'G2', 'G3', '']
    const mk = (pre: string, n: number) => Array.from({ length: n }, (_, i) => {
      const tv = Math.round(r() * 100000) / 100
      const rate = pick(r, [0, 0.05, 0.12, 0.18])
      const t = Math.round(tv * rate * 100) / 100
      const inter = r() < 0.5
      return E(`${pre}${i}`, pick(r, gstins), `${pick(r, ['INV', 'INV-', 'A/', ''])}${Math.floor(r() * 12)}`, tv, inter ? 0 : t / 2, inter ? 0 : t / 2, inter ? t : 0)
    })
    const pr = mk('p', nPr), tb = mk('t', nTb)
    const res = reconcile(pr, tb)

    const prSeen = res.map(x => x.pr_entry_id).filter(Boolean) as string[]
    const tbSeen = res.map(x => x.gstr2b_entry_id).filter(Boolean) as string[]
    assert.equal(new Set(prSeen).size, prSeen.length, `PR row reported twice (seed ${SEED}, round ${round})`)
    assert.equal(new Set(tbSeen).size, tbSeen.length, `2B row reported twice (seed ${SEED}, round ${round})`)
    assert.equal(prSeen.length, nPr, 'every PR row must appear exactly once')
    assert.equal(tbSeen.length, nTb, 'every 2B row must appear exactly once')

    for (const x of res) {
      assert.ok(x.itc_at_risk >= 0 && Number.isFinite(x.itc_at_risk))
      assert.ok(Number.isFinite(x.taxable_variance) && Number.isFinite(x.tax_variance))
      assert.ok(x.confidence >= 0 && x.confidence <= 1)
      if (x.status === 'BOOKS_ONLY') assert.ok(x.pr_entry_id && !x.gstr2b_entry_id)
      if (x.status === 'TWOB_ONLY') assert.ok(!x.pr_entry_id && x.gstr2b_entry_id)
      if (x.status === 'MATCHED') assert.equal(x.itc_at_risk, 0)
      if (x.status === 'MATCHED' || x.status === 'MISMATCH') assert.ok(x.pr_entry_id && x.gstr2b_entry_id)
    }
  }
})

test('reconcile: identical books and 2B => everything MATCHED; empty sides => all *_ONLY', () => {
  const rows = Array.from({ length: 500 }, (_, i) => E(`p${i}`, `G${i % 7}`, `INV-${i}`, 1000 + i, 90, 90, 0))
  const twin = rows.map(x => ({ ...x, id: 't' + x.id.slice(1) }))
  assert.ok(reconcile(rows, twin).every(x => x.status === 'MATCHED'))
  assert.ok(reconcile(rows, []).every(x => x.status === 'BOOKS_ONLY'))
  assert.ok(reconcile([], twin).every(x => x.status === 'TWOB_ONLY'))
  assert.equal(reconcile([], []).length, 0)
})

test('reconcile is deterministic', () => {
  const pr = Array.from({ length: 200 }, (_, i) => E(`p${i}`, `G${i % 5}`, `INV-${i % 150}`, 500 + (i % 9) * 40, 45, 45, 0))
  const tb = Array.from({ length: 200 }, (_, i) => E(`t${i}`, `G${i % 5}`, `INV/${(i * 7) % 150}`, 500 + (i % 9) * 40, 45, 45, 0))
  assert.deepEqual(reconcile(pr, tb), reconcile(pr, tb))
})

test('import parsers: arbitrary JSON/CSV garbage only ever fails with ImportError (never a crash)', () => {
  const r = rng(SEED + 5)
  const junk = (depth = 0): unknown => {
    const k = r()
    if (depth > 3 || k < 0.35) return pick<unknown>(r, [...NASTY, 0, 1.5, -3, true, false, null, 'ctin', 'inv'])
    if (k < 0.65) return Array.from({ length: Math.floor(r() * 5) }, () => junk(depth + 1))
    return Object.fromEntries(Array.from({ length: Math.floor(r() * 6) }, () =>
      [pick(r, ['gstr_2b', 'records', 'companies', 'purchase_register', 'supplier_gstin', 'invoice_number', 'ctin', 'inv', 'itms', 'data', 'docdata', 'b2b', 'gstin', 'x']), junk(depth + 1)]))
  }
  for (let i = 0; i < 2000; i++) {
    const j = junk()
    for (const fn of [() => parseGstr2bJson(j, opts), () => parsePurchaseRegisterJson(j, opts)]) {
      try { fn() } catch (e) { assert.ok(e instanceof ImportError, `crash: ${(e as Error).stack}\ninput: ${JSON.stringify(j)?.slice(0, 200)} (seed ${SEED})`) }
    }
  }
  for (let i = 0; i < 300; i++) {
    const bytes = Buffer.from(Array.from({ length: Math.floor(r() * 400) }, () => Math.floor(r() * 256)))
    try { parseGstr2bExcel(bytes, opts) } catch (e) { assert.ok(e instanceof ImportError, `excel crash: ${(e as Error).message}`) }
  }
})

test('realistic rows with random mutations always yield well-formed entries', () => {
  const r = rng(SEED + 6)
  for (let i = 0; i < 1000; i++) {
    const row: Record<string, unknown> = {
      supplier_gstin: pick(r, ['27AABCU9603R1ZX', ' 27aabcu9603r1zx ', '', '27 AABCU9603R1ZX']),
      invoice_number: pick(r, ['INV-001', 'inv/1', '', '0001', 'A B C']),
      invoice_date: pick<unknown>(r, ['2026-09-01', '01-09-2026', '01-Sep-2026', 'garbage', '', 46000, null]),
      taxable_value: pick<unknown>(r, [1000, '1,000.00', '₹1000', '', null, 'x', '(50)']),
      cgst: pick<unknown>(r, [90, '90', '', null]), sgst: pick<unknown>(r, [90, '90']), igst: pick<unknown>(r, [0, '', null]),
    }
    try {
      for (const e of parseGstr2bJson({ gstr_2b: [row] }, opts).entries) {
        assert.match(e.inv_date, /^\d{4}-\d{2}-\d{2}$/)
        assert.ok(e.supplier_gstin && e.inv_no)
        assert.ok([e.taxable_value, e.cgst, e.sgst, e.igst].every(Number.isFinite))
        assert.equal(e.supplier_gstin, e.supplier_gstin.toUpperCase().replace(/\s/g, ''))
      }
    } catch (e) { assert.ok(e instanceof ImportError) }
  }
})
