import { NextResponse } from 'next/server'
import { parseGstr2bJson, parseGstr2bExcel, parsePurchaseRegisterJson } from '@/lib/gstr2b-parser'
import { getDbAndOrg } from '@/lib/db'
import { normalizeGstin, normalizeInvNo } from '@/lib/normalize'
import crypto from 'crypto'

export async function POST(req: Request) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

  const formData = await req.formData()
  const file = formData.get('file') as File | null
  const clientId = formData.get('client_id') as string
  const period = formData.get('period') as string

  if (!file || !clientId || !period) {
    return NextResponse.json({ error: 'file, client_id, period required' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex')

  // Remove only the raw 2B entries — match_results are rebuilt on next reconcile run.
  // Deleting match_results here would destroy all user review decisions.
  await db.from('gstr2b_entries').delete().eq('client_id', clientId).eq('period', period)

  let prInserted = 0
  let entries
  if (file.name.endsWith('.json')) {
    const json = JSON.parse(buffer.toString('utf-8')) as Record<string, unknown>
    entries = parseGstr2bJson(json)

    // If the JSON also has a purchase_register array, import it directly
    const prEntries = parsePurchaseRegisterJson(json)
    if (prEntries.length > 0) {
      await db.from('purchase_register_entries').delete().eq('client_id', clientId).eq('period', period)
      const prRows = prEntries.map(e => ({
        org_id: orgId, client_id: clientId, period,
        supplier_gstin: e.supplier_gstin,
        norm_supplier_gstin: normalizeGstin(e.supplier_gstin),
        inv_no: e.inv_no,
        norm_inv_no: normalizeInvNo(e.inv_no),
        inv_date: e.inv_date,
        taxable_value: e.taxable_value,
        cgst: e.cgst, sgst: e.sgst, igst: e.igst,
        is_rcm: e.is_rcm ?? false,
        doc_type: e.doc_type ?? 'invoice',
        extraction_confidence: 1.0,
        source: 'import',
      }))
      const { error: prError } = await db.from('purchase_register_entries').insert(prRows)
      if (!prError) prInserted = prRows.length
    }
  } else {
    entries = parseGstr2bExcel(buffer)
  }

  const rows = entries.map(e => ({ ...e, org_id: orgId, client_id: clientId, period }))
  const { error } = await db.from('gstr2b_entries').insert(rows)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ inserted: rows.length, pr_inserted: prInserted, file_hash: fileHash })
}
