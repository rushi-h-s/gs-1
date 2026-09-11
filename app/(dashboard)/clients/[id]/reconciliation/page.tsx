import { createClient } from '@/utils/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import Link from 'next/link'
import BreakReviewCard from './BreakReviewCard'
import ReconAgent from '@/components/ReconAgent'
import { explainBreak } from '@/lib/explain-break'
import { acceptAllMatched, lockPeriod } from './actions'

const BUCKETS: Record<string, { label: string; color: string; bg: string; text: string }> = {
  MATCHED:    { label: 'Matched',     color: '#059669', bg: '#D1FAE5', text: '#065F46' },
  PROBABLE:   { label: 'Probable',    color: '#D97706', bg: '#FEF3C7', text: '#92400E' },
  MISMATCH:   { label: 'Mismatch',    color: '#DC2626', bg: '#FEE2E2', text: '#991B1B' },
  BOOKS_ONLY: { label: 'Books Only',  color: '#2563EB', bg: '#DBEAFE', text: '#1E40AF' },
  TWOB_ONLY:  { label: '2B Only',     color: '#7C3AED', bg: '#EDE9FE', text: '#4C1D95' },
}

export default async function ReconciliationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ period?: string; status?: string; break?: string; view?: string; unconfirmed?: string }>
}) {
  const { id } = await params
  const { period, status: filterStatus, break: breakParam, view, unconfirmed } = await searchParams
  const unconfirmedSkipped = unconfirmed ? parseInt(unconfirmed, 10) : 0
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const db = user ? supabase : createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: clientRow } = await db.from('clients').select('name, gstin').eq('id', id).single()

  // Latest run for this client+period
  let runQuery = db.from('recon_run').select('id, period, status, created_at, rules_version, totals').eq('client_id', id).order('created_at', { ascending: false }).limit(1)
  if (period) runQuery = runQuery.eq('period', period)
  const { data: runs } = await runQuery
  const latestRun = runs?.[0] ?? null
  const totals = (latestRun?.totals ?? {}) as Record<string, number>

  // All match_results for the run (or client+period fallback)
  let baseQuery = db.from('match_results').select(`
    id, status, confidence, mismatched_fields,
    pr_entry_id, gstr2b_entry_id,
    taxable_variance, tax_variance, itc_at_risk,
    evidence, user_status, resolution_reason, resolution_note,
    purchase_register_entries(supplier_gstin, inv_no, norm_inv_no, inv_date, taxable_value, cgst, sgst, igst),
    gstr2b_entries(supplier_gstin, inv_no, norm_inv_no, inv_date, taxable_value, cgst, sgst, igst)
  `).eq('client_id', id)

  if (latestRun) baseQuery = baseQuery.eq('run_id', latestRun.id)
  else if (period) baseQuery = baseQuery.eq('period', period)

  const { data: allResults } = await baseQuery.order('itc_at_risk', { ascending: false })
  const results = allResults ?? []

  // Counts across all buckets
  const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {} as Record<string, number>)
  const total = results.length

  // Break queue: unreviewed + non-MATCHED, sorted by itc_at_risk desc (already ordered)
  const breakQueue = results.filter(r =>
    r.status !== 'MATCHED' && r.user_status === 'unreviewed'
  )
  const flagged = results.filter(r => r.user_status === 'flagged')
  const breakIdx = Math.min(parseInt(breakParam ?? '0', 10), Math.max(breakQueue.length - 1, 0))
  const currentBreak = breakQueue[breakIdx] ?? null

  // Metric strip values
  const matchedRun = latestRun ? (totals.auto_matched_pct ?? null) : null
  const openBreaks = latestRun ? (totals.open_breaks ?? breakQueue.length) : breakQueue.length
  const itcAtRisk = latestRun ? (totals.itc_at_risk ?? 0) : results.reduce((s, r) => s + (r.itc_at_risk ?? 0), 0)
  const runTime = latestRun ? new Date(latestRun.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : null

  // GSTR-3B filing deadline: 20th of the month after the period
  const filingDeadline = period ? (() => {
    const [y, m] = period.split('-').map(Number)
    const next = new Date(y, m, 20) // month is 0-indexed, so m = next month's 20th
    return next.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  })() : null

  // Is the period already locked?
  const { data: lockRow } = await db.from('locked_periods')
    .select('id, locked_at').eq('client_id', id).eq('period', period ?? '').maybeSingle()
  const isLocked = !!lockRow

  // CSV export
  const csvRows = [
    ['Status', 'User Status', 'Supplier GSTIN', 'Invoice No', 'Taxable', 'CGST', 'SGST', 'IGST', 'ITC at Risk', 'Mismatched Fields', 'Resolution'].join(','),
    ...results.map(r => {
      const entry = (r.purchase_register_entries as unknown as Record<string, unknown> | null) ?? (r.gstr2b_entries as unknown as Record<string, unknown> | null) ?? {}
      return [
        r.status, r.user_status,
        entry.supplier_gstin ?? '', entry.norm_inv_no ?? '',
        entry.taxable_value ?? '', r.taxable_variance ?? '',
        entry.cgst ?? '', entry.sgst ?? '', entry.igst ?? '',
        r.itc_at_risk ?? '',
        (r.mismatched_fields ?? []).join(';'),
        r.resolution_reason ?? '',
      ].join(',')
    }),
  ].join('\n')

  const showFlaggedView = view === 'flagged'

  return (
    <div className="max-w-5xl">
      {unconfirmedSkipped > 0 && (
        <div className="rounded-xl border px-4 py-3 mb-4 flex items-center justify-between"
          style={{ background: '#FEF3C7', borderColor: '#FDE68A' }}>
          <span className="text-sm" style={{ color: '#92400E' }}>
            {unconfirmedSkipped} invoice{unconfirmedSkipped !== 1 ? 's' : ''} with unconfirmed extraction were excluded — results are incomplete.
          </span>
          <Link href={`/clients/${id}/confirm`}
            className="text-xs font-semibold underline ml-4 shrink-0" style={{ color: '#92400E' }}>
            Confirm now →
          </Link>
        </div>
      )}
      {/* Back + header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <Link href={`/clients/${id}`} className="inline-flex items-center gap-1.5 text-xs font-medium mb-3 transition-colors hover:opacity-70" style={{ color: 'var(--text-3)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
            {clientRow?.name ?? 'Back'}
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold font-display" style={{ color: 'var(--text-1)' }}>Reconciliation</h1>
            {latestRun && (
              <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${latestRun.status === 'complete' ? 'text-emerald-700' : 'text-red-700'}`}
                style={{ background: latestRun.status === 'complete' ? '#D1FAE5' : '#FEE2E2' }}>
                {latestRun.status === 'complete' ? 'balances tied' : 'balances off'}
              </span>
            )}
          </div>
          {period && (
            <p className="text-xs font-mono mt-1 tracking-wider" style={{ color: 'var(--text-3)' }}>
              {period} · {clientRow?.gstin}
              {runTime && ` · run ${runTime}`}
              {latestRun?.rules_version && `, rules ${latestRun.rules_version}`}
              {filingDeadline && !isLocked && (
                <span style={{ color: '#D97706' }}> · 3B due {filingDeadline}</span>
              )}
              {isLocked && (
                <span style={{ color: '#059669' }}> · filed {new Date(lockRow!.locked_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
              )}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`data:text/csv;charset=utf-8,${encodeURIComponent(csvRows)}`}
            download={`reconciliation-${id}-${period ?? 'all'}.csv`}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold font-display border"
            style={{ borderColor: 'var(--border)', color: 'var(--text-2)' }}
          >
            Export CSV
          </a>
        </div>
      </div>

      {/* Metric strip */}
      {total > 0 && (
        <div className="grid grid-cols-4 gap-3 mb-5">
          {[
            { label: 'Transactions', value: String(total) },
            { label: 'Auto-matched', value: matchedRun != null ? `${matchedRun}%` : `${Math.round(((counts.MATCHED ?? 0) / total) * 100)}%` },
            { label: 'Open breaks', value: String(openBreaks) },
            { label: 'ITC at risk', value: `₹${Number(itcAtRisk).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` },
          ].map(m => (
            <div key={m.label} className="rounded-xl border p-4" style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}>
              <div className="text-xs mb-1" style={{ color: 'var(--text-3)' }}>{m.label}</div>
              <div className="text-2xl font-semibold font-display" style={{ color: 'var(--text-1)' }}>{m.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Summary bar */}
      {total > 0 && (
        <div className="bg-white rounded-2xl border p-5 mb-5" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold tracking-widest uppercase font-display" style={{ color: 'var(--text-3)' }}>
              Breakdown — {total} entries
            </span>
            <div className="flex items-center gap-3">
              {flagged.length > 0 && (
                <Link href={`/clients/${id}/reconciliation?period=${period}&view=flagged`}
                  className="text-xs font-medium flex items-center gap-1"
                  style={{ color: '#D97706' }}>
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                  {flagged.length} flagged
                </Link>
              )}
              {latestRun && (counts.MATCHED ?? 0) > 0 && (
                <form action={async () => { 'use server'; await acceptAllMatched(latestRun.id) }}>
                  <button type="submit" className="text-xs font-medium px-2.5 py-1 rounded-md border"
                    style={{ borderColor: '#059669', color: '#065F46', background: '#D1FAE5' }}>
                    Accept all Matched
                  </button>
                </form>
              )}
              {filterStatus && (
                <Link href={`/clients/${id}/reconciliation?period=${period}`} className="text-xs font-medium" style={{ color: 'var(--primary)' }}>
                  Clear filter ×
                </Link>
              )}
            </div>
          </div>
          {/* Segmented bar */}
          <div className="flex rounded-lg overflow-hidden h-2.5 mb-4">
            {Object.entries(BUCKETS).map(([key, bucket]) => {
              const count = counts[key] ?? 0
              if (!count) return null
              return (
                <div key={key} style={{ width: `${(count / total) * 100}%`, background: bucket.color, minWidth: 2 }}
                  title={`${bucket.label}: ${count}`} />
              )
            })}
          </div>
          {/* Bucket pills */}
          <div className="flex flex-wrap gap-2">
            {Object.entries(BUCKETS).map(([key, bucket]) => {
              const count = counts[key] ?? 0
              if (!count) return null
              return (
                <Link key={key} href={`/clients/${id}/reconciliation?period=${period}&status=${key}`}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold font-display transition-opacity hover:opacity-80"
                  style={{ background: bucket.bg, color: bucket.text, border: `1px solid ${bucket.color}22` }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: bucket.color }} />
                  {bucket.label}
                  <span className="font-mono font-bold">{count}</span>
                </Link>
              )
            })}
          </div>
        </div>
      )}

      {/* Flagged list view */}
      {showFlaggedView && flagged.length > 0 && (
        <div className="bg-white rounded-2xl border mb-5 overflow-hidden" style={{ borderColor: 'var(--border)' }}>
          <div className="px-5 py-3.5 border-b flex items-center justify-between" style={{ borderColor: 'var(--border)' }}>
            <span className="text-sm font-semibold font-display" style={{ color: 'var(--text-1)' }}>Flagged for client</span>
            <Link href={`/clients/${id}/reconciliation?period=${period}`} className="text-xs" style={{ color: 'var(--text-3)' }}>← Back to queue</Link>
          </div>
          {flagged.map((r, i) => {
            const entry = (r.purchase_register_entries as unknown as Record<string, unknown> | null) ?? (r.gstr2b_entries as unknown as Record<string, unknown> | null) ?? {}
            return (
              <div key={r.id} className="px-5 py-4 border-b last:border-0 flex items-center justify-between gap-4" style={{ borderColor: 'var(--border)' }}>
                <div>
                  <div className="text-sm font-medium font-mono" style={{ color: 'var(--text-1)' }}>{String(entry.norm_inv_no ?? '—')}</div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>{String(entry.supplier_gstin ?? '—')}</div>
                  {r.resolution_note && <div className="text-xs mt-1 italic" style={{ color: 'var(--text-3)' }}>{r.resolution_note}</div>}
                </div>
                <div className="text-sm font-semibold font-mono text-right" style={{ color: '#DC2626' }}>
                  ₹{Number(r.itc_at_risk ?? 0).toLocaleString('en-IN')}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Break review card */}
      {!showFlaggedView && breakQueue.length > 0 && currentBreak && latestRun && (
        <div className="mb-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-semibold font-display" style={{ color: 'var(--text-1)' }}>
              Break queue <span className="font-mono font-bold" style={{ color: '#DC2626' }}>{breakQueue.length}</span> open
            </span>
            <span className="text-xs" style={{ color: 'var(--text-3)' }}>
              Sorted by ITC at risk · A accept · F flag · ← → navigate
            </span>
          </div>
          <BreakReviewCard
            match={currentBreak as Parameters<typeof BreakReviewCard>[0]['match']}
            breakIndex={breakIdx}
            totalBreaks={breakQueue.length}
            runId={latestRun.id}
            clientId={id}
            explainText={explainBreak({
              status: currentBreak.status as Parameters<typeof explainBreak>[0]['status'],
              taxable_variance: currentBreak.taxable_variance ?? 0,
              tax_variance: currentBreak.tax_variance ?? 0,
              itc_at_risk: currentBreak.itc_at_risk ?? 0,
              pr_taxable: (() => {
                const pr = currentBreak.purchase_register_entries as unknown as Record<string, unknown> | null
                return pr ? Number(pr.taxable_value ?? 0) : null
              })(),
              pr_inv_no: (() => {
                const pr = currentBreak.purchase_register_entries as unknown as Record<string, unknown> | null
                return pr ? String(pr.norm_inv_no ?? '') : null
              })(),
              twob_inv_no: (() => {
                const tb = currentBreak.gstr2b_entries as unknown as Record<string, unknown> | null
                return tb ? String(tb.norm_inv_no ?? '') : null
              })(),
              evidence: currentBreak.evidence as Parameters<typeof explainBreak>[0]['evidence'],
            })}
          />
        </div>
      )}

      {/* Empty state — all breaks reviewed, prompt to lock/file */}
      {!showFlaggedView && breakQueue.length === 0 && total > 0 && (
        <div className="rounded-2xl border p-12 text-center" style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}>
          <div className="text-4xl mb-3">✓</div>
          <div className="text-sm font-semibold font-display" style={{ color: 'var(--text-1)' }}>All breaks reviewed</div>
          <div className="text-xs mt-1 mb-6" style={{ color: 'var(--text-3)' }}>
            {flagged.length > 0 ? `${flagged.length} flagged for client · ` : ''}
            {isLocked
              ? `Period locked — filed ${new Date(lockRow!.locked_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
              : filingDeadline ? `GSTR-3B due ${filingDeadline}` : 'Ready to file'}
          </div>
          {!isLocked && period && (
            <form action={async () => { 'use server'; await lockPeriod(id, period) }}>
              <button type="submit"
                className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white font-display"
                style={{ background: '#059669' }}>
                Mark as Filed & Lock Period
              </button>
            </form>
          )}
          {isLocked && (
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold font-display"
              style={{ background: '#D1FAE5', color: '#065F46' }}>
              <span>Period Locked</span>
            </div>
          )}
        </div>
      )}

      {total === 0 && (
        <div className="rounded-2xl border p-16 text-center" style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}>
          <div className="text-sm font-semibold font-display mb-1" style={{ color: 'var(--text-1)' }}>No reconciliation results</div>
          <div className="text-xs" style={{ color: 'var(--text-3)' }}>Upload invoices and GSTR-2B, then run reconciliation</div>
        </div>
      )}

      {/* Recon assistant — grounded in this run's data */}
      {latestRun && total > 0 && (
        <div className="mt-5">
          <ReconAgent clientId={id} period={period ?? latestRun.period} />
        </div>
      )}
    </div>
  )
}
