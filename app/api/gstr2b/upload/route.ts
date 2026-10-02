import { NextResponse } from 'next/server'
import {
  ImportError, parseGstr2bJson, parseGstr2bExcel, parsePurchaseRegisterJson,
  type Gstr2bEntry, type ParseOptions,
} from '@/lib/gstr2b-parser'
import { getDbAndOrg, fetchAll, inChunks } from '@/lib/db'
import crypto from 'crypto'
import { withLock } from '@/lib/lock'

export const maxDuration = 60
const MAX_BYTES = 15 * 1024 * 1024
const CHUNK = 500

type Db = Awaited<ReturnType<typeof getDbAndOrg>>['db']

/**
 * Replace one client+period's rows in `table` with `entries` without ever leaving the period empty:
 * insert the new rows first (rolling them back if any slice fails), and only then drop the old ones.
 * match_results point at entry ids, so they are cleared for the period (the next reconcile rebuilds them).
 */
async function replaceEntries(
  db: Db, table: 'gstr2b_entries' | 'purchase_register_entries',
  orgId: string, clientId: string, period: string, rows: Record<string, unknown>[],
) {
  const oldIds = (await fetchAll<{ id: string }>(() =>
    db.from(table).select('id').eq('org_id', orgId).eq('client_id', clientId).eq('period', period).order('id')
  )).map(r => r.id)

  const newIds: string[] = []
  try {
    await inChunks(rows, CHUNK, async slice => {
      const { data, error } = await db.from(table).insert(slice).select('id')
      data?.forEach(d => newIds.push(d.id))
      return { error }
    })
  } catch (e) {
    await inChunks(newIds, CHUNK, slice => db.from(table).delete().in('id', slice)).catch(() => {})
    throw e
  }

  if (oldIds.length) {
    await db.from('match_results').delete().eq('org_id', orgId).eq('client_id', clientId).eq('period', period)
    await inChunks(oldIds, CHUNK, slice => db.from(table).delete().in('id', slice))
  }
}

const toRow = (e: Gstr2bEntry, orgId: string, clientId: string, period: string) => ({
  org_id: orgId, client_id: clientId, period,
  supplier_gstin: e.supplier_gstin, norm_supplier_gstin: e.norm_supplier_gstin,
  inv_no: e.inv_no, norm_inv_no: e.norm_inv_no, inv_date: e.inv_date,
  taxable_value: e.taxable_value, cgst: e.cgst, sgst: e.sgst, igst: e.igst,
  doc_type: e.doc_type, is_rcm: e.is_rcm,
})

export async function POST(req: Request) {
  const { db, orgId, user } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: user ? 'No org' : 'Not signed in' }, { status: user ? 403 : 401 })

  if (Number(req.headers.get('content-length') ?? 0) > MAX_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: `File is too large; the limit is ${MAX_BYTES / 1048576} MB` }, { status: 413 })
  }
  const formData = await req.formData().catch(() => null)
  const file = formData?.get('file') as File | null
  const clientId = formData?.get('client_id') as string | null
  const period = formData?.get('period') as string | null

  if (!file || !clientId || !period) {
    return NextResponse.json({ error: 'file, client_id, period required' }, { status: 400 })
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    return NextResponse.json({ error: 'period must look like 2026-09' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `File is ${(file.size / 1048576).toFixed(1)} MB; the limit is ${MAX_BYTES / 1048576} MB` }, { status: 413 })
  }

  const { data: client } = await db.from('clients').select('gstin').eq('id', clientId).eq('org_id', orgId).maybeSingle()
  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  const { data: lock } = await db.from('locked_periods').select('id')
    .eq('org_id', orgId).eq('client_id', clientId).eq('period', period).limit(1).maybeSingle()
  if (lock) return NextResponse.json({ error: 'Period is locked — unlock it before importing' }, { status: 409 })

  const buffer = Buffer.from(await file.arrayBuffer())
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const opts: ParseOptions = { fallbackDate: `${period}-01`, clientGstin: client.gstin }

  // Parse EVERYTHING before touching the database, so a bad file can never wipe good data.
  let twoB: Gstr2bEntry[]
  let pr: Gstr2bEntry[] = []
  let warnings: string[] = []
  try {
    if (/\.json$/i.test(file.name)) {
      let json: unknown
      try { json = JSON.parse(buffer.toString('utf-8')) } catch { throw new ImportError('File is not valid JSON.') }
      const a = parseGstr2bJson(json, opts)
      const b = parsePurchaseRegisterJson(json, opts)
      twoB = a.entries; pr = b.entries; warnings = [...a.warnings, ...b.warnings]
    } else {
      const a = parseGstr2bExcel(buffer, opts)
      twoB = a.entries; warnings = a.warnings
    }
  } catch (e) {
    if (e instanceof ImportError) return NextResponse.json({ error: e.message }, { status: 400 })
    console.error('gstr2b parse failed', e)
    return NextResponse.json({ error: 'Could not read this file.' }, { status: 400 })
  }

  try {
    // one import per client+period at a time, otherwise two overlapping imports each keep their own copy
    await withLock(`import:${clientId}:${period}`, async () => {
      await replaceEntries(db, 'gstr2b_entries', orgId, clientId, period, twoB.map(e => toRow(e, orgId, clientId, period)))
      if (pr.length) {
        await replaceEntries(db, 'purchase_register_entries', orgId, clientId, period, pr.map(e => ({
          ...toRow(e, orgId, clientId, period),
          extraction_confidence: 1.0, source: 'upload', needs_confirmation: false,
        })))
      }
    })
  } catch (e) {
    console.error('gstr2b import failed', e)
    return NextResponse.json({ error: `Import failed, nothing was changed: ${(e as Error).message}` }, { status: 500 })
  }

  return NextResponse.json({ inserted: twoB.length, pr_inserted: pr.length, file_hash: fileHash, warnings })
}
