import { getDbAndOrg } from '@/lib/db'
import Link from 'next/link'

interface PrEntry {
  id: string
  supplier_gstin: string | null
  inv_no: string | null
  inv_date: string | null
  taxable_value: number | null
  cgst: number | null
  sgst: number | null
  igst: number | null
  extraction_confidence: number | null
  needs_confirmation: boolean | null
  confirmed_at: string | null
  source: string | null
  file_hash: string | null
}

function confBadge(conf: number | null) {
  const c = conf ?? 0
  if (c >= 0.8) return { label: `${c.toFixed(2)}`, color: '#065F46', bg: '#D1FAE5' }
  if (c >= 0.5) return { label: `${c.toFixed(2)}`, color: '#92400E', bg: '#FEF3C7' }
  return { label: `${c.toFixed(2)}`, color: '#991B1B', bg: '#FEE2E2' }
}

function fmt(v: number | null) {
  return v != null ? Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'
}

export default async function ExtractedDataPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ period?: string }>
}) {
  const { id } = await params
  const { period } = await searchParams
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return <div className="p-8">Not authorised.</div>

  const { data: clientRow } = await db.from('clients').select('name, gstin').eq('id', id).single()

  let q = db.from('purchase_register_entries')
    .select('id, supplier_gstin, inv_no, inv_date, taxable_value, cgst, sgst, igst, extraction_confidence, needs_confirmation, confirmed_at, source, file_hash')
    .eq('org_id', orgId).eq('client_id', id)
    .order('extraction_confidence', { ascending: true })
  if (period) q = q.eq('period', period)
  const { data: entries } = await q

  const rows = (entries ?? []) as PrEntry[]
  const flagged = rows.filter(r => r.needs_confirmation && !r.confirmed_at)
  const buyerGstinHit = rows.filter(r => r.supplier_gstin === clientRow?.gstin)

  return (
    <div className="max-w-5xl">
      <Link href={`/clients/${id}`} className="inline-flex items-center gap-1.5 text-xs font-medium mb-3 transition-colors hover:opacity-70" style={{ color: 'var(--text-3)' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 12H5M12 5l-7 7 7 7"/>
        </svg>
        {clientRow?.name ?? 'Back'}
      </Link>
      <h1 className="text-2xl font-bold font-display mb-1" style={{ color: 'var(--text-1)' }}>Extracted Invoice Data</h1>
      <p className="text-xs mb-5" style={{ color: 'var(--text-3)' }}>
        {rows.length} entries{period ? ` for ${period}` : ' (all periods)'} — review before reconciling.
        {flagged.length > 0 && <span style={{ color: '#DC2626' }}> · {flagged.length} need confirmation</span>}
      </p>

      {buyerGstinHit.length > 0 && (
        <div className="rounded-xl border px-4 py-3 mb-4" style={{ background: '#FEE2E2', borderColor: '#FECACA' }}>
          <span className="text-sm" style={{ color: '#991B1B' }}>
            {buyerGstinHit.length} entr{buyerGstinHit.length !== 1 ? 'ies' : 'y'} show the client&apos;s own GSTIN as the supplier — extraction likely misread a &quot;Bill To&quot; block instead of the supplier. Re-extract or correct manually.
          </span>
        </div>
      )}

      <div className="bg-white rounded-2xl border overflow-x-auto" style={{ borderColor: 'var(--border)' }}>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b" style={{ borderColor: 'var(--border)' }}>
              {['Status', 'Supplier GSTIN', 'Invoice No', 'Date', 'Taxable', 'CGST', 'SGST', 'IGST', 'Confidence', 'Source'].map(h => (
                <th key={h} className="text-left px-3 py-2 font-semibold" style={{ color: 'var(--text-3)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const badge = confBadge(r.extraction_confidence)
              const isBuyerGstin = r.supplier_gstin === clientRow?.gstin
              const needsReview = r.needs_confirmation && !r.confirmed_at
              return (
                <tr key={r.id} className="border-b last:border-0" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-3 py-2">
                    {needsReview ? (
                      <Link href={`/clients/${id}/confirm`} className="text-xs font-semibold underline" style={{ color: '#D97706' }}>Review</Link>
                    ) : (
                      <span className="text-xs" style={{ color: '#059669' }}>OK</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono" style={isBuyerGstin ? { color: '#DC2626', fontWeight: 600 } : undefined}>
                    {r.supplier_gstin || '—'}{isBuyerGstin && ' ⚠'}
                  </td>
                  <td className="px-3 py-2 font-mono">{r.inv_no || '—'}</td>
                  <td className="px-3 py-2">{r.inv_date || '—'}</td>
                  <td className="px-3 py-2 text-right">{fmt(r.taxable_value)}</td>
                  <td className="px-3 py-2 text-right">{fmt(r.cgst)}</td>
                  <td className="px-3 py-2 text-right">{fmt(r.sgst)}</td>
                  <td className="px-3 py-2 text-right">{fmt(r.igst)}</td>
                  <td className="px-3 py-2">
                    <span className="px-1.5 py-0.5 rounded font-semibold" style={{ background: badge.bg, color: badge.color }}>{badge.label}</span>
                  </td>
                  <td className="px-3 py-2" style={{ color: 'var(--text-3)' }}>{r.source || '—'}</td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-8 text-center" style={{ color: 'var(--text-3)' }}>No entries yet — upload invoices first.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
