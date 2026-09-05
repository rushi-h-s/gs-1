import { NextResponse } from 'next/server'
import { reconcile } from '@/lib/reconciliation'
import { getDbAndOrg } from '@/lib/db'

export async function POST(req: Request) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

  const { client_id, period } = await req.json()
  if (!client_id || !period) return NextResponse.json({ error: 'client_id and period required' }, { status: 400 })

  // Guard: prevent re-runs on locked periods
  const { data: lock } = await db.from('locked_periods')
    .select('id').eq('org_id', orgId).eq('client_id', client_id).eq('period', period).single()
  if (lock) return NextResponse.json({ error: 'Period is locked' }, { status: 409 })

  const [{ data: prEntries }, { data: twoBEntries }] = await Promise.all([
    db.from('purchase_register_entries')
      .select('id, norm_supplier_gstin, norm_inv_no, invoice_number, taxable_value, cgst, sgst, igst, extraction_confidence')
      .eq('org_id', orgId).eq('client_id', client_id).eq('period', period),
    db.from('gstr2b_entries')
      .select('id, norm_supplier_gstin, norm_inv_no, invoice_number, taxable_value, cgst, sgst, igst')
      .eq('org_id', orgId).eq('client_id', client_id).eq('period', period),
  ])

  const results = reconcile(prEntries ?? [], twoBEntries ?? [])

  // Compute run totals
  const total = results.length
  const matched = results.filter(r => r.status === 'MATCHED').length
  const openBreaks = results.filter(r => r.status !== 'MATCHED').length
  const itcAtRisk = results.reduce((s, r) => s + (r.itc_at_risk ?? 0), 0)
  const autoMatchedPct = total > 0 ? Math.round((matched / total) * 100) : 0

  // Determine balance status: if total tax variance is material (>₹100)
  const totalTaxVariance = results.reduce((s, r) => s + (r.tax_variance ?? 0), 0)
  const runStatus = Math.abs(totalTaxVariance) > 100 ? 'balances_off' : 'complete'

  // Insert the run record
  const { data: run, error: runError } = await db.from('recon_run').insert({
    org_id: orgId,
    client_id,
    period,
    rules_version: 'v1',
    status: runStatus,
    totals: { total, auto_matched_pct: autoMatchedPct, open_breaks: openBreaks, itc_at_risk: itcAtRisk },
  }).select('id').single()

  if (runError || !run) return NextResponse.json({ error: runError?.message ?? 'run insert failed' }, { status: 500 })

  // Carry forward review decisions for unchanged matches, reset changed ones
  const { data: prior } = await db.from('match_results')
    .select('id, pr_entry_id, gstr2b_entry_id, user_status, resolution_reason, resolution_note, reviewed_by, reviewed_at, taxable_variance')
    .eq('org_id', orgId).eq('client_id', client_id).eq('period', period)

  const priorByKey = new Map<string, typeof prior extends (infer T)[] | null ? T : never>()
  for (const p of prior ?? []) {
    const key = `${p.pr_entry_id ?? ''}::${p.gstr2b_entry_id ?? ''}`
    priorByKey.set(key, p)
  }

  // Delete old rows
  await db.from('match_results').delete().eq('client_id', client_id).eq('period', period)

  if (results.length) {
    const rows = results.map(r => {
      const key = `${r.pr_entry_id ?? ''}::${r.gstr2b_entry_id ?? ''}`
      const prev = priorByKey.get(key)
      // Carry review forward only if variance is unchanged (same amount, no refiling)
      const sameVariance = prev && Math.abs((prev.taxable_variance ?? 0) - (r.taxable_variance ?? 0)) < 1
      return {
        ...r,
        org_id: orgId,
        client_id,
        period,
        run_id: run.id,
        user_status: sameVariance && prev?.user_status !== 'unreviewed' ? prev!.user_status : 'unreviewed',
        resolution_reason: sameVariance ? (prev?.resolution_reason ?? null) : null,
        resolution_note: sameVariance ? (prev?.resolution_note ?? null) : null,
        reviewed_by: sameVariance ? (prev?.reviewed_by ?? null) : null,
        reviewed_at: sameVariance ? (prev?.reviewed_at ?? null) : null,
      }
    })
    const { error } = await db.from('match_results').insert(rows)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // ─── Break history upsert ─────────────────────────────────────────
  const now = new Date().toISOString()

  // Build entry lookup from PR+2B data in one pass
  const entryMap = new Map<string, { gstin: string; inv_no: string }>()
  ;[...(prEntries ?? []), ...(twoBEntries ?? [])].forEach((e: any) => entryMap.set(e.id, {
    gstin: e.norm_supplier_gstin ?? '',
    inv_no: e.norm_inv_no ?? '',
  }))

  const nonMatched = results.filter(r => r.status !== 'MATCHED')

  // Collect keys for non-matched breaks
  const breakKeys = nonMatched
    .map(r => entryMap.get(r.pr_entry_id ?? r.gstr2b_entry_id ?? ''))
    .filter(Boolean) as { gstin: string; inv_no: string }[]

  if (breakKeys.length) {
    // Bulk read all existing break_history rows in one query
    const { data: existing } = await db.from('break_history')
      .select('id, norm_supplier_gstin, norm_inv_no, periods_open')
      .eq('client_id', client_id)
      .in('norm_supplier_gstin', breakKeys.map(k => k.gstin))

    const existingMap = new Map(
      (existing ?? []).map(e => [`${e.norm_supplier_gstin}::${e.norm_inv_no}`, e])
    )

    const toInsert: object[] = []
    // Serial updates still needed (incrementing periods_open per-row); batched where possible
    for (let i = 0; i < nonMatched.length; i++) {
      const r = nonMatched[i]
      const entry = entryMap.get(r.pr_entry_id ?? r.gstr2b_entry_id ?? '')
      if (!entry) continue
      const { gstin, inv_no } = entry
      const ex = existingMap.get(`${gstin}::${inv_no}`)
      if (ex) {
        await db.from('break_history').update({
          periods_open: (ex.periods_open ?? 0) + 1,
          last_seen_period: period,
          last_status: r.status,
          last_itc_at_risk: r.itc_at_risk ?? 0,
          updated_at: now,
          resolved_at: null,
        }).eq('id', ex.id)
      } else {
        toInsert.push({
          client_id,
          norm_supplier_gstin: gstin,
          norm_inv_no: inv_no,
          first_seen_period: period,
          periods_open: 1,
          last_seen_period: period,
          last_status: r.status,
          last_itc_at_risk: r.itc_at_risk ?? 0,
          resolved_at: null,
          updated_at: now,
        })
      }
    }
    // Bulk insert all new break rows
    if (toInsert.length) await db.from('break_history').insert(toInsert)
  }

  // Resolve MATCHED rows in bulk — one update with .in() instead of N serial calls
  const matchedKeys = results
    .filter(r => r.status === 'MATCHED')
    .map(r => entryMap.get(r.pr_entry_id ?? r.gstr2b_entry_id ?? ''))
    .filter(Boolean) as { gstin: string; inv_no: string }[]

  if (matchedKeys.length) {
    await db.from('break_history')
      .update({ resolved_at: now })
      .eq('client_id', client_id)
      .in('norm_supplier_gstin', matchedKeys.map(k => k.gstin))
  }

  const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {} as Record<string, number>)
  return NextResponse.json({ run_id: run.id, counts, total, status: runStatus, itc_at_risk: itcAtRisk })
}

