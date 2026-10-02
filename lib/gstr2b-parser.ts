import * as XLSX from 'xlsx'
import { normalizeGstin, normalizeInvNo, parseDate, parseNum } from './normalize.ts'

export interface Gstr2bEntry {
  supplier_gstin: string
  norm_supplier_gstin: string
  inv_no: string
  inv_date: string
  norm_inv_no: string
  taxable_value: number
  cgst: number
  sgst: number
  igst: number
  doc_type: 'invoice' | 'credit_note' | 'debit_note'
  is_rcm: boolean
}

export type PurchaseRegisterEntry = Gstr2bEntry

export interface ParseResult {
  entries: Gstr2bEntry[]
  /** Row-level problems (bad dates, missing keys…). Never fatal on their own. */
  warnings: string[]
}

export class ImportError extends Error {}

// ── Field aliases ─────────────────────────────────────────────────────────────
// Keys are compared after lowercasing and dropping everything but a-z0-9, so
// "Taxable Value (₹)", "taxable_value" and "TaxableValue" are the same key.
const ALIASES = {
  gstin: ['suppliergstin', 'gstinofsupplier', 'gstinsupplier', 'ctin', 'gstin', 'supplierctin'],
  invNo: ['invoicenumber', 'invoiceno', 'invno', 'inum', 'invnumber', 'documentnumber', 'docno'],
  date: ['invoicedate', 'invdate', 'dt', 'date', 'documentdate'],
  taxable: ['taxablevalue', 'taxable', 'taxableamount', 'txval', 'taxablevalueinr'],
  cgst: ['cgst', 'cgstamount', 'centraltaxamount', 'centraltax', 'camt'],
  sgst: ['sgst', 'sgstamount', 'stateuttaxamount', 'statetaxamount', 'statetax', 'samt', 'utgst'],
  igst: ['igst', 'igstamount', 'integratedtaxamount', 'integratedtax', 'iamt'],
  rcm: ['reversecharge', 'isrcm', 'rcm', 'rchrg'],
  recipient: ['recipientgstin', 'gstin2brecipient', 'gstinofrecipient', 'buyergstin'],
} as const

const nk = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')

function pick(row: Map<string, unknown>, names: readonly string[]): unknown {
  for (const n of names) if (row.has(n)) return row.get(n)
  return undefined
}

function docTypeOf(row: Map<string, unknown>): Gstr2bEntry['doc_type'] {
  let raw = ''
  for (const [k, v] of row) {
    if (/^(invoicetype|documenttype|doctype|typ|notetype)/.test(k)) { raw = String(v).toLowerCase(); break }
  }
  if (raw.includes('credit') || raw === 'cr' || raw === 'c') return 'credit_note'
  if (raw.includes('debit') || raw === 'dr' || raw === 'd') return 'debit_note'
  return 'invoice'
}

/** One loosely-shaped row -> Gstr2bEntry, or a reason it can't be used. */
function mapRow(raw: Record<string, unknown>, label: string, fallbackDate: string): { entry?: Gstr2bEntry; warning?: string; recipient?: string } {
  const row = new Map(Object.entries(raw).map(([k, v]) => [nk(k), v]))
  const gstin = normalizeGstin(String(pick(row, ALIASES.gstin) ?? ''))
  const invNo = String(pick(row, ALIASES.invNo) ?? '').trim()
  if (!gstin || !invNo) return { warning: `${label}: skipped — missing supplier GSTIN or invoice number` }

  const rawDate = pick(row, ALIASES.date)
  let date = parseDate(rawDate)
  let warning: string | undefined
  if (!date) {
    date = fallbackDate
    warning = `${label}: date ${JSON.stringify(rawDate ?? '')} not recognised, used ${fallbackDate}`
  }
  const rcm = String(pick(row, ALIASES.rcm) ?? '').toLowerCase()
  return {
    warning,
    recipient: normalizeGstin(String(pick(row, ALIASES.recipient) ?? '')),
    entry: {
      supplier_gstin: gstin,
      norm_supplier_gstin: gstin,
      inv_no: invNo,
      norm_inv_no: normalizeInvNo(invNo),
      inv_date: date,
      taxable_value: parseNum(pick(row, ALIASES.taxable)),
      cgst: parseNum(pick(row, ALIASES.cgst)),
      sgst: parseNum(pick(row, ALIASES.sgst)),
      igst: parseNum(pick(row, ALIASES.igst)),
      doc_type: docTypeOf(row),
      is_rcm: ['true', 'yes', 'y', '1'].includes(rcm),
    },
  }
}

function mapRows(rows: unknown[], fallbackDate: string, what: string, clientGstin?: string): ParseResult {
  let entries: Gstr2bEntry[] = []
  const recipients: string[] = []
  const warnings: string[] = []
  rows.forEach((r, i) => {
    if (!r || typeof r !== 'object') return
    const { entry, warning, recipient } = mapRow(r as Record<string, unknown>, `${what} row ${i + 1}`, fallbackDate)
    if (warning) warnings.push(warning)
    if (entry) { entries.push(entry); recipients.push(recipient ?? '') }
  })

  // Files that carry a recipient GSTIN per row (multi-company workbooks): keep this client's rows only.
  const want = clientGstin ? normalizeGstin(clientGstin) : ''
  if (want && recipients.some(Boolean)) {
    if (recipients.includes(want)) entries = entries.filter((_, i) => recipients[i] === want)
    else warnings.unshift(`Recipient GSTIN in this file (${[...new Set(recipients.filter(Boolean))].join(', ')}) does not match the client's GSTIN — imported anyway.`)
  }
  return { entries, warnings: warnings.slice(0, 20).concat(warnings.length > 20 ? [`…and ${warnings.length - 20} more`] : []) }
}

const asObj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/**
 * Find the row array for one side ('gstr_2b' | 'purchase_register') in the many JSON
 * layouts seen in the wild. `clientGstin` disambiguates multi-company files.
 */
function findRows(json: unknown, side: 'gstr_2b' | 'purchase_register', clientGstin?: string): unknown[] | null {
  if (Array.isArray(json)) return side === 'gstr_2b' ? json : null
  const o = asObj(json)
  if (!o) return null

  if (Array.isArray(o[side])) return o[side] as unknown[]

  if (Array.isArray(o.companies)) {
    const companies = o.companies as Array<Record<string, unknown>>
    const mine = clientGstin ? companies.filter(c => normalizeGstin(String(c.gstin ?? '')) === normalizeGstin(clientGstin)) : []
    if (!mine.length) {
      if (side === 'purchase_register') return null
      throw new ImportError(
        `File has ${companies.length} companies (${companies.map(c => c.gstin).join(', ')}); none matches this client's GSTIN.`
      )
    }
    const rows = mine.flatMap(c => (Array.isArray(c[side]) ? (c[side] as unknown[]) : []))
    return rows.length ? rows : null
  }

  if (side === 'gstr_2b') {
    for (const k of ['records', 'entries', 'invoices', 'b2b_invoices']) if (Array.isArray(o[k])) return o[k] as unknown[]
  }
  return null
}

/** GST-portal JSON: data.docdata.b2b[].inv[] (also b2ba). Returns null when the shape isn't portal-style. */
function parsePortal(json: Record<string, unknown>, fallbackDate: string): ParseResult | null {
  const docdata = asObj(asObj(json.data)?.docdata) ?? asObj(json.docdata) ?? json
  const blocks = ['b2b', 'b2ba'].flatMap(k => (Array.isArray(docdata[k]) ? (docdata[k] as unknown[]).filter(asObj) as Array<Record<string, unknown>> : []))
  if (!blocks.length) return null

  const rows: Record<string, unknown>[] = []
  for (const rec of blocks) {
    const ctin = String(rec.ctin ?? rec.gstin ?? '')
    const invs = Array.isArray(rec.inv) ? (rec.inv as unknown[]).filter(asObj) as Array<Record<string, unknown>> : []
    for (const inv of invs) {
      const items = (Array.isArray(inv.itms) && inv.itms.length ? (inv.itms as unknown[]).filter(asObj) : [inv]) as Array<Record<string, unknown>>
      const sum = (key: string) => items.reduce((s, it) => s + parseNum((asObj(it.itm_det) ?? it)[key]), 0)
      rows.push({
        ctin, inum: inv.inum ?? inv.invoice_number, dt: inv.dt ?? inv.inv_date, typ: inv.typ,
        txval: sum('txval'), camt: sum('camt'), samt: sum('samt'), iamt: sum('iamt'), rchrg: inv.rchrg,
      })
    }
  }
  return mapRows(rows, fallbackDate, 'portal invoice')
}

export interface ParseOptions {
  /** 'YYYY-MM-01'-style date used when a row's own date is unreadable. */
  fallbackDate: string
  clientGstin?: string
}

const NOT_FOUND = (what: string, keys: string[]) =>
  new ImportError(
    `Could not find ${what} rows in this file (top-level keys: ${keys.slice(0, 8).join(', ') || 'none'}). ` +
    `Expected an array under gstr_2b / records, a GST-portal b2b block, or an Excel/CSV table with GSTIN + invoice number columns.`
  )

/** Any unexpected shape surfaces as an ImportError (a clean 400), never a raw crash. */
function guarded<T>(fn: () => T): T {
  try { return fn() } catch (e) {
    if (e instanceof ImportError) throw e
    throw new ImportError('This file has an unexpected structure and could not be read.')
  }
}

export function parseGstr2bJson(json: unknown, opts: ParseOptions): ParseResult {
  return guarded(() => parseGstr2bJsonUnsafe(json, opts))
}

function parseGstr2bJsonUnsafe(json: unknown, opts: ParseOptions): ParseResult {
  const o = asObj(json)
  if (o && Array.isArray(o.test_cases) && !findRows(json, 'gstr_2b', opts.clientGstin)) {
    throw new ImportError('This is a one-sided test-case file (no GSTR-2B rows). Upload a GSTR-2B file instead.')
  }
  const rows = findRows(json, 'gstr_2b', opts.clientGstin)
  const result = rows ? mapRows(rows, opts.fallbackDate, 'GSTR-2B', opts.clientGstin) : (o && parsePortal(o, opts.fallbackDate))
  if (!result) throw NOT_FOUND('GSTR-2B', Object.keys(o ?? {}))
  if (!result.entries.length) {
    throw new ImportError(`Found rows but none had a supplier GSTIN and invoice number. ${result.warnings[0] ?? ''}`.trim())
  }
  return result
}

/** Purchase-register rows embedded in the same JSON (Acme-style files). Empty result = none present. */
export function parsePurchaseRegisterJson(json: unknown, opts: ParseOptions): ParseResult {
  return guarded(() => {
    const rows = findRows(json, 'purchase_register', opts.clientGstin)
    return rows ? mapRows(rows, opts.fallbackDate, 'Purchase register', opts.clientGstin) : { entries: [], warnings: [] }
  })
}

/**
 * Rows of a sheet as objects, starting at the real header row. GSTN exports and hand-made
 * sheets often have a title / metadata block above the table, so the header is the first
 * row (of the first 40) that names both a GSTIN and an invoice-number column.
 */
function sheetObjects(ws: XLSX.WorkSheet): Record<string, unknown>[] {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' })
  const isHeader = (cells: unknown[]) => {
    const keys = cells.map(c => nk(String(c)))
    return ALIASES.gstin.some(a => keys.includes(a)) && ALIASES.invNo.some(a => keys.includes(a))
  }
  const h = grid.slice(0, 40).findIndex(isHeader)
  if (h < 0) return []
  const names = grid[h].map(c => String(c).trim())
  return grid.slice(h + 1).map(row => Object.fromEntries(names.map((n, i) => [n || `col${i}`, row[i] ?? ''])))
}

/** .xlsx / .xls / .csv — every sheet that has a usable table is read (extra Summary/Notes sheets are ignored). */
export function parseGstr2bExcel(buffer: Buffer, opts: ParseOptions): ParseResult {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buffer, { type: 'buffer' })
  } catch {
    throw new ImportError('Could not read this file as Excel or CSV.')
  }
  const rows = wb.SheetNames.flatMap(name => sheetObjects(wb.Sheets[name]))
  if (!rows.length) {
    throw new ImportError(
      'No table found. The sheet needs a header row with a supplier GSTIN column and an invoice number column ' +
      '(e.g. "GSTIN of Supplier", "Invoice Number").'
    )
  }
  const res = mapRows(rows, opts.fallbackDate, 'row', opts.clientGstin)
  if (!res.entries.length) throw new ImportError(`Found a table but no row had both a GSTIN and an invoice number. ${res.warnings[0] ?? ''}`.trim())
  return res
}
