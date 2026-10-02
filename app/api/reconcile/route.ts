import { NextResponse } from 'next/server'
import { reconcile, type Entry } from '@/lib/reconciliation'
import { getDbAndOrg, fetchAll, inChunks } from '@/lib/db'
import { normalizeGstin, normalizeInvNo } from '@/lib/normalize'
import { withLock } from '@/lib/lock'

export const maxDuration = 60
const CHUNK = 500

interface Row {
  id: string
  supplier_gstin: string | null
  inv_no: string | null
  norm_supplier_gstin: string | null
  norm_inv_no: string | null
  taxable_value: number | null
  cgst: number | null
  sgst: number | null
  igst: number | null
  extraction_confidence?: number | null
}

/**
 * Keys are re-derived from the raw GSTIN / invoice number on every run, so rows stored with an
 * older normaliser (or by another import path) still match.
 */
function toEntry(r: Row): Entry {
  return {
    id: r.id,
    norm_supplier_gstin: r.supplier_gstin ? normalizeGstin(r.supplier_gstin) : (r.norm_supplier_gstin ?? ''),
    norm_inv_no: r.inv_no ? normalizeInvNo(r.inv_no) : (r.norm_inv_no ?? ''),
    taxable_value: Number(r.taxable_value ?? 0),
    cgst: Number(r.cgst ?? 0),
    sgst: Number(r.sgst ?? 0),
    igst: Number(r.igst ?? 0),
    extraction_confidence: r.extraction_confidence ?? undefined,
  }
}

export async function POST(req: Request) {
  const { db, orgId, user } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: user ? 'No org' : 'Not signed in' }, { status: user ? 403 : 401 })

  const { client_id, period } = await req.json().catch(() => ({}))
  if (!client_id || !period) return NextResponse.json({ error: 'client_id and period required' }, { status: 400 })

  // One reconcile per client+period at a time (a second click waits, then re-runs on fresh data).
  return withLock(`recon:${client_id}:${period}`, async () => {
    // Guard: prevent re-runs on locked periods
    const { data: lock } = await db.from('locked_periods')
      .select('id').eq('org_id', orgId).eq('client_id', client_id).eq('period', period).limit(1).maybeSingle()
    if (lock) return NextResponse.json({ error: 'Period is locked' }, { status: 409 })

    // Unconfirmed entries have null GSTIN/inv_no and can never match — excluded below, counted here.
    const { count: unconfirmedCount } = await db.from('purchase_register_entries')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId).eq('client_id', client_id).eq('period', period)
      .eq('needs_confirmation', true).is('confirmed_at', null)
    const unconfirmed = unconfirmedCount ?? 0

    let prRows: Row[], twoBRows: Row[]
    try {
      // fetchAll: a plain select silently stops at 1000 rows
      ;[prRows, twoBRows] = await Promise.all([
        fetchAll<Row>(() => db.from('purchase_register_entries')
          .select('id, supplier_gstin, inv_no, norm_supplier_gstin, norm_inv_no, taxable_value, cgst, sgst, igst, extraction_confidence')
          .eq('org_id', orgId).eq('client_id', client_id).eq('period', period)
          .or('needs_confirmation.eq.false,needs_confirmation.is.null')
          .order('id')),
        fetchAll<Row>(() => db.from('gstr2b_entries')
          .select('id, supplier_gstin, inv_no, norm_supplier_gstin, norm_inv_no, taxable_value, cgst, sgst, igst')
          .eq('org_id', orgId).eq('client_id', client_id).eq('period', period)
          .order('id')),
      ])
    } catch (e) {
      return NextResponse.json({ error: `Could not load entries: ${(e as Error).message}` }, { status: 500 })
    }

    if (!prRows.length && !twoBRows.length) {
      return NextResponse.json(
        { error: `No purchase-register or GSTR-2B data for ${period}. Import data for this period first.`, unconfirmed_skipped: unconfirmed },
        { status: 400 },
      )
    }

    const prEntries = prRows.map(toEntry)
    const twoBEntries = twoBRows.map(toEntry)
    const results = reconcile(prEntries, twoBEntries)

    // Compute run totals
    const total = results.length
    const matched = results.filter(r => r.status === 'MATCHED').length
    const openBreaks = total - matched
    const itcAtRisk = results.reduce((s, r) => s + (r.itc_at_risk ?? 0), 0)
    const autoMatchedPct = total > 0 ? Math.round((matched / total) * 100) : 0

    // Balance status: material if total tax variance > ₹100
    const totalTaxVariance = results.reduce((s, r) => s + (r.tax_variance ?? 0), 0)
    const runStatus = Math.abs(totalTaxVariance) > 100 ? 'balances_off' : 'complete'

    const { data: run, error: runError } = await db.from('recon_run').insert({
      org_id: orgId,
      client_id,
      period,
      rules_version: 'v1',
      status: runStatus,
      totals: { total, auto_matched_pct: autoMatchedPct, open_breaks: openBreaks, itc_at_risk: itcAtRisk },
    }).select('id, created_at').single()
    if (runError || !run) return NextResponse.json({ error: runError?.message ?? 'run insert failed' }, { status: 500 })

    // Carry forward review decisions for unchanged matches, reset changed ones
    const prior = await fetchAll<{
      id: string; pr_entry_id: string | null; gstr2b_entry_id: string | null; user_status: string
      resolution_reason: string | null; resolution_note: string | null
      reviewed_by: string | null; reviewed_at: string | null; taxable_variance: number | null
    }>(() => db.from('match_results')
      .select('id, pr_entry_id, gstr2b_entry_id, user_status, resolution_reason, resolution_note, reviewed_by, reviewed_at, taxable_variance')
      .eq('org_id', orgId).eq('client_id', client_id).eq('period', period).order('id'))
      .catch(() => [])

    const priorByKey = new Map(prior.map(p => [`${p.pr_entry_id ?? ''}::${p.gstr2b_entry_id ?? ''}`, p]))

    const rows = results.map(r => {
      const prev = priorByKey.get(`${r.pr_entry_id ?? ''}::${r.gstr2b_entry_id ?? ''}`)
      // Carry review forward only if variance is unchanged (same amount, no refiling)
      const same = !!prev && Math.abs((prev.taxable_variance ?? 0) - (r.taxable_variance ?? 0)) < 1
      return {
        ...r,
        org_id: orgId, client_id, period, run_id: run.id,
        user_status: same && prev!.user_status !== 'unreviewed' ? prev!.user_status : 'unreviewed',
        resolution_reason: same ? prev!.resolution_reason : null,
        resolution_note: same ? prev!.resolution_note : null,
        reviewed_by: same ? prev!.reviewed_by : null,
        reviewed_at: same ? prev!.reviewed_at : null,
      }
    })

    // Insert the new rows first; only once they are all in do the old rows go. A failure part-way
    // rolls the new run back, so the user keeps their previous (reviewed) results instead of losing them.
    try {
      await inChunks(rows, CHUNK, slice => db.from('match_results').insert(slice))
    } catch (e) {
      await db.from('match_results').delete().eq('run_id', run.id)
      await db.from('recon_run').delete().eq('id', run.id)
      return NextResponse.json({ error: `Saving results failed, previous results kept: ${(e as Error).message}` }, { status: 500 })
    }
    // Newest run wins, even across server instances: if a later run for this period already exists,
    // this one is stale and removes its own rows; otherwise it clears every older run's rows.
    const { data: newer } = await db.from('recon_run').select('id')
      .eq('org_id', orgId).eq('client_id', client_id).eq('period', period)
      .gt('created_at', run.created_at).limit(1)
    if (newer?.length) {
      await db.from('match_results').delete().eq('run_id', run.id)
      return NextResponse.json({ run_id: newer[0].id, superseded: true, counts: {}, total: 0, note: 'A newer reconcile finished first; its results are kept.' })
    }
    await db.from('match_results').delete()
      .eq('org_id', orgId).eq('client_id', client_id).eq('period', period)
      .or(`run_id.is.null,run_id.neq.${run.id}`)

    const historyError = await updateBreakHistory(db, orgId, client_id, period, results, [...prEntries, ...twoBEntries])

    const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {} as Record<string, number>)
    return NextResponse.json({
      run_id: run.id, counts, total, status: runStatus, itc_at_risk: itcAtRisk,
      unconfirmed_skipped: unconfirmed,
      inputs: { purchase_register: prEntries.length, gstr2b: twoBEntries.length },
      ...(historyError ? { warning: `Ageing history not updated: ${historyError}` } : {}),
    })
  })
}

/** Re-seen in the same period: unchanged. Reopened after being resolved: restart at 1. Otherwise one more period. */
function periodsOpen(ex: { periods_open: number | null; last_seen_period: string | null; resolved_at: string | null }, period: string) {
  if (ex.resolved_at) return 1
  if (ex.last_seen_period === period) return ex.periods_open ?? 1
  return (ex.periods_open ?? 0) + 1
}

type Db = Awaited<ReturnType<typeof getDbAndOrg>>['db']

/**
 * Cross-period ageing. periods_open only grows when the break is seen in a NEW period, so
 * re-running the same period no longer inflates it. Returns an error string instead of throwing:
 * the reconcile itself has already succeeded by the time this runs.
 */
async function updateBreakHistory(
  db: Db, orgId: string, clientId: string, period: string,
  results: ReturnType<typeof reconcile>, entries: Entry[],
): Promise<string | null> {
  try {
    const now = new Date().toISOString()
    const keyOf = new Map(entries.map(e => [e.id, `${e.norm_supplier_gstin}::${e.norm_inv_no}`]))
    const entryKey = (r: (typeof results)[number]) => keyOf.get(r.pr_entry_id ?? r.gstr2b_entry_id ?? '')

    const existing = await fetchAll<{
      id: string; norm_supplier_gstin: string; norm_inv_no: string
      periods_open: number | null; last_seen_period: string | null; resolved_at: string | null
    }>(() => db.from('break_history')
      .select('id, norm_supplier_gstin, norm_inv_no, periods_open, last_seen_period, resolved_at')
      .eq('client_id', clientId).order('id'))
    const existingByKey = new Map(existing.map(e => [`${e.norm_supplier_gstin}::${e.norm_inv_no}`, e]))

    const seen = new Set<string>()
    const toInsert: object[] = []
    const run = async (batch: PromiseLike<{ error: { message: string } | null }>[]) => {
      for (const res of await Promise.all(batch)) if (res.error) throw new Error(res.error.message)
    }

    const pending: PromiseLike<{ error: { message: string } | null }>[] = []
    for (const r of results) {
      if (r.status === 'MATCHED') continue
      const key = entryKey(r)
      if (!key || seen.has(key)) continue
      seen.add(key)
      const [gstin, inv_no] = key.split('::')
      const ex = existingByKey.get(key)
      if (ex) {
        pending.push(db.from('break_history').update({
          periods_open: periodsOpen(ex, period),
          last_seen_period: period, last_status: r.status, last_itc_at_risk: r.itc_at_risk ?? 0,
          updated_at: now, resolved_at: null,
        }).eq('id', ex.id))
      } else {
        toInsert.push({
          org_id: orgId, client_id: clientId, norm_supplier_gstin: gstin, norm_inv_no: inv_no,
          first_seen_period: period, periods_open: 1, last_seen_period: period,
          last_status: r.status, last_itc_at_risk: r.itc_at_risk ?? 0, resolved_at: null, updated_at: now,
        })
      }
      if (pending.length >= 25) await run(pending.splice(0))
    }
    await run(pending.splice(0))

    await inChunks(toInsert, CHUNK, slice => db.from('break_history').insert(slice))

    // Anything that now matches cleanly and was open is resolved — exact keys only.
    const resolveIds = results
      .filter(r => r.status === 'MATCHED')
      .map(r => entryKey(r))
      .filter((k): k is string => !!k && !seen.has(k))
      .map(k => existingByKey.get(k))
      .filter((e): e is NonNullable<typeof e> => !!e && !e.resolved_at)
      .map(e => e.id)
    await inChunks([...new Set(resolveIds)], CHUNK, slice => db.from('break_history').update({ resolved_at: now }).in('id', slice))
    return null
  } catch (e) {
    console.error('break_history update failed', e)
    return (e as Error).message
  }
}
