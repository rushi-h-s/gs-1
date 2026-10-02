import { getDbAndOrg } from '@/lib/db'
import Link from 'next/link'

function bucketOf(periodsOpen: number): '1 month' | '2–3 months' | '3+ months' {
  if (periodsOpen <= 1) return '1 month'
  if (periodsOpen <= 3) return '2–3 months'
  return '3+ months'
}

export default async function AgeingPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { db } = await getDbAndOrg()

  const { data: clientRow } = await db.from('clients').select('name, gstin').eq('id', id).single()

  const { data: openBreaks } = await db
    .from('break_history')
    .select('id, norm_supplier_gstin, norm_inv_no, first_seen_period, last_seen_period, periods_open, last_status, last_itc_at_risk')
    .eq('client_id', id)
    .is('resolved_at', null)
    .order('periods_open', { ascending: false })

  const rows = openBreaks ?? []
  const totalRisk = rows.reduce((s, r) => s + Number(r.last_itc_at_risk ?? 0), 0)

  const groups: Record<string, typeof rows> = { '1 month': [], '2–3 months': [], '3+ months': [] }
  for (const r of rows) groups[bucketOf(r.periods_open ?? 1)].push(r)

  return (
    <div className="max-w-5xl">
      <div className="mb-7">
        <Link href={`/clients/${id}`} className="inline-flex items-center gap-1.5 text-xs font-medium mb-3 transition-colors hover:opacity-70" style={{ color: 'var(--text-3)' }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
          {clientRow?.name ?? 'Back'}
        </Link>
        <h1 className="text-2xl font-bold font-display" style={{ color: 'var(--text-1)' }}>Ageing Report</h1>
        <p className="text-xs font-mono mt-1 tracking-wider" style={{ color: 'var(--text-3)' }}>
          {clientRow?.gstin} · open breaks carried across periods
        </p>
      </div>

      {/* Totals strip */}
      <div className="grid grid-cols-3 gap-4 mb-5">
        <div className="bg-white rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
          <div className="text-xs font-semibold tracking-wider uppercase mb-1" style={{ color: 'var(--text-3)' }}>Open breaks</div>
          <div className="text-xl font-bold font-display" style={{ color: 'var(--text-1)' }}>{rows.length}</div>
        </div>
        <div className="bg-white rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
          <div className="text-xs font-semibold tracking-wider uppercase mb-1" style={{ color: 'var(--text-3)' }}>Total ITC at risk</div>
          <div className="text-xl font-bold font-display" style={{ color: '#DC2626' }}>₹{totalRisk.toLocaleString('en-IN')}</div>
        </div>
        <div className="bg-white rounded-xl border p-4" style={{ borderColor: 'var(--border)' }}>
          <div className="text-xs font-semibold tracking-wider uppercase mb-1" style={{ color: 'var(--text-3)' }}>Oldest bucket (3+ months)</div>
          <div className="text-xl font-bold font-display" style={{ color: 'var(--text-1)' }}>{groups['3+ months'].length}</div>
        </div>
      </div>

      {(Object.keys(groups) as (keyof typeof groups)[]).map(bucket => (
        <div key={bucket} className="bg-white rounded-2xl border overflow-hidden mb-5" style={{ borderColor: 'var(--border)' }}>
          <div className="px-5 py-3.5 font-semibold text-sm font-display" style={{ background: 'var(--bg)', color: 'var(--text-2)' }}>
            {bucket} — {groups[bucket].length} break{groups[bucket].length === 1 ? '' : 's'}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th className="px-5 py-3 text-left text-xs font-semibold tracking-wider uppercase font-display" style={{ color: 'var(--text-3)' }}>Supplier GSTIN</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold tracking-wider uppercase font-display" style={{ color: 'var(--text-3)' }}>Invoice No</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold tracking-wider uppercase font-display" style={{ color: 'var(--text-3)' }}>First seen</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold tracking-wider uppercase font-display" style={{ color: 'var(--text-3)' }}>Periods open</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold tracking-wider uppercase font-display" style={{ color: 'var(--text-3)' }}>Last status</th>
                  <th className="px-5 py-3 text-right text-xs font-semibold tracking-wider uppercase font-display" style={{ color: 'var(--text-3)' }}>ITC at risk</th>
                </tr>
              </thead>
              <tbody>
                {groups[bucket].map(r => (
                  <tr key={r.id} className="hover:bg-slate-50 transition-colors" style={{ borderBottom: '1px solid var(--border)' }}>
                    <td className="px-5 py-3 font-mono text-xs" style={{ color: 'var(--text-2)' }}>{r.norm_supplier_gstin}</td>
                    <td className="px-5 py-3 font-mono text-xs" style={{ color: 'var(--text-1)' }}>{r.norm_inv_no}</td>
                    <td className="px-5 py-3 font-mono text-xs" style={{ color: 'var(--text-2)' }}>{r.first_seen_period}</td>
                    <td className="px-5 py-3 font-mono text-xs" style={{ color: 'var(--text-1)' }}>{r.periods_open}</td>
                    <td className="px-5 py-3 text-xs" style={{ color: 'var(--text-2)' }}>{r.last_status}</td>
                    <td className="px-5 py-3 text-right font-mono text-sm font-medium" style={{ color: '#DC2626' }}>
                      ₹{Number(r.last_itc_at_risk ?? 0).toLocaleString('en-IN')}
                    </td>
                  </tr>
                ))}
                {!groups[bucket].length && (
                  <tr><td colSpan={6} className="px-5 py-6 text-center text-xs" style={{ color: 'var(--text-3)' }}>No breaks in this bucket</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
