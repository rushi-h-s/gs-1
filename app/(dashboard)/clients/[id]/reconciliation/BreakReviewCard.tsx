'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { acceptMatch, flagMatch, repairMatch } from './actions'

type JoinedEntry = Record<string, unknown> | Record<string, unknown>[] | null

interface MatchRow {
  id: string
  status: string
  confidence: number
  mismatched_fields: string[] | null
  pr_entry_id: string | null
  gstr2b_entry_id: string | null
  taxable_variance: number | null
  tax_variance: number | null
  itc_at_risk: number | null
  evidence: Record<string, unknown> | null
  user_status: string
  resolution_reason: string | null
  resolution_note: string | null
  purchase_register_entries: JoinedEntry
  gstr2b_entries: JoinedEntry
}

function flattenEntry(e: JoinedEntry): Record<string, unknown> | null {
  if (!e) return null
  return Array.isArray(e) ? (e[0] ?? null) : e
}

const REASON_OPTIONS = [
  { value: 'tds', label: 'TDS' },
  { value: 'tcs', label: 'TCS' },
  { value: 'rounding', label: 'Rounding' },
  { value: 'freight', label: 'Freight' },
  { value: 'refiling', label: 'Refiling' },
  { value: 'other', label: 'Other' },
]

const BUCKETS: Record<string, { label: string; color: string; bg: string; text: string }> = {
  MATCHED:    { label: 'Matched',     color: '#059669', bg: '#D1FAE5', text: '#065F46' },
  PROBABLE:   { label: 'Probable',    color: '#D97706', bg: '#FEF3C7', text: '#92400E' },
  MISMATCH:   { label: 'Mismatch',    color: '#DC2626', bg: '#FEE2E2', text: '#991B1B' },
  BOOKS_ONLY: { label: 'Books Only',  color: '#2563EB', bg: '#DBEAFE', text: '#1E40AF' },
  TWOB_ONLY:  { label: '2B Only',     color: '#7C3AED', bg: '#EDE9FE', text: '#4C1D95' },
}

export default function BreakReviewCard({
  match,
  breakIndex,
  totalBreaks,
  explainText,
  runId,
  clientId,
}: {
  match: MatchRow
  breakIndex: number
  totalBreaks: number
  explainText: string
  runId: string
  clientId: string
}) {
  const router = useRouter()
  const [showAcceptPicker, setShowAcceptPicker] = useState(false)
  const [showFlagInput, setShowFlagInput] = useState(false)
  const [flagNote, setFlagNote] = useState('')
  const [loading, setLoading] = useState(false)

  const pr = flattenEntry(match.purchase_register_entries)
  const tb = flattenEntry(match.gstr2b_entries)
  const bucket = BUCKETS[match.status]
  const evidence = match.evidence as Record<string, unknown> | null

  const navigateBreak = useCallback((newIdx: number) => {
    const url = new URL(window.location.href)
    url.searchParams.set('break', String(newIdx))
    router.push(url.pathname + url.search)
  }, [router])

  const handleAccept = useCallback(async (reason: string) => {
    setLoading(true)
    try {
      await acceptMatch(match.id, reason)
      navigateBreak(Math.min(breakIndex + 1, totalBreaks - 1))
    } finally {
      setLoading(false)
      setShowAcceptPicker(false)
    }
  }, [match.id, breakIndex, totalBreaks, navigateBreak])

  const handleFlag = useCallback(async () => {
    if (!flagNote.trim()) return
    setLoading(true)
    try {
      await flagMatch(match.id, flagNote.trim())
      navigateBreak(Math.min(breakIndex + 1, totalBreaks - 1))
    } finally {
      setLoading(false)
      setShowFlagInput(false)
      setFlagNote('')
    }
  }, [match.id, flagNote, breakIndex, totalBreaks, navigateBreak])

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'a' || e.key === 'A') { setShowAcceptPicker(true) }
      if (e.key === 'f' || e.key === 'F') { setShowFlagInput(true) }
      if (e.key === 'ArrowRight') { navigateBreak(Math.min(breakIndex + 1, totalBreaks - 1)) }
      if (e.key === 'ArrowLeft') { navigateBreak(Math.max(breakIndex - 1, 0)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [breakIndex, totalBreaks, navigateBreak])

  return (
    <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
      {/* Card header */}
      <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--border)' }}>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold font-display"
            style={{ background: bucket?.bg ?? '#F1F5F9', color: bucket?.text ?? '#475569' }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: bucket?.color }} />
            {bucket?.label ?? match.status}
          </span>
          <span className="text-xs font-mono" style={{ color: 'var(--text-3)' }}>
            Break {breakIndex + 1} of {totalBreaks}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => navigateBreak(Math.max(breakIndex - 1, 0))} disabled={breakIndex === 0}
            className="p-1.5 rounded-md border text-xs disabled:opacity-30" style={{ borderColor: 'var(--border)' }}>←</button>
          <button onClick={() => navigateBreak(Math.min(breakIndex + 1, totalBreaks - 1))} disabled={breakIndex >= totalBreaks - 1}
            className="p-1.5 rounded-md border text-xs disabled:opacity-30" style={{ borderColor: 'var(--border)' }}>→</button>
        </div>
      </div>

      {/* Two-column comparison */}
      <div className="grid grid-cols-2 divide-x" style={{ borderColor: 'var(--border)' }}>
        {/* PR column */}
        <div className="p-6">
          <div className="text-xs font-semibold tracking-wider uppercase mb-3 font-display" style={{ color: 'var(--text-3)' }}>
            Purchase Register
          </div>
          <div className="space-y-2.5">
            <FieldRow label="Supplier" value={String(pr?.supplier_gstin ?? '—')} mono />
            <FieldRow label="Invoice No" value={String(pr?.norm_inv_no ?? '—')} mono />
            <FieldRow label="Date" value={pr?.inv_date ? String(pr.inv_date) : '—'} mono />
            <FieldRow label="Taxable" value={Number(pr?.taxable_value ?? 0).toLocaleString('en-IN')} right />
            <FieldRow label="CGST" value={Number(pr?.cgst ?? 0).toLocaleString('en-IN')} right />
            <FieldRow label="SGST" value={Number(pr?.sgst ?? 0).toLocaleString('en-IN')} right />
            <FieldRow label="IGST" value={Number(pr?.igst ?? 0).toLocaleString('en-IN')} right />
          </div>
        </div>

        {/* 2B column */}
        <div className="p-6">
          <div className="text-xs font-semibold tracking-wider uppercase mb-3 font-display" style={{ color: 'var(--text-3)' }}>
            GSTR-2B
          </div>
          {tb ? (
            <div className="space-y-2.5">
              <FieldRow label="Supplier" value={String(tb.supplier_gstin ?? '—')} mono />
              <FieldRow label="Invoice No" value={String(tb.norm_inv_no ?? '—')} mono />
              <FieldRow label="Date" value={tb.inv_date ? String(tb.inv_date) : '—'} mono />
              <FieldRow label="Taxable" value={Number(tb.taxable_value ?? 0).toLocaleString('en-IN')} right />
              <FieldRow label="CGST" value={Number(tb.cgst ?? 0).toLocaleString('en-IN')} right />
              <FieldRow label="SGST" value={Number(tb.sgst ?? 0).toLocaleString('en-IN')} right />
              <FieldRow label="IGST" value={Number(tb.igst ?? 0).toLocaleString('en-IN')} right />
            </div>
          ) : (
            <div className="text-xs py-8 text-center" style={{ color: 'var(--text-3)' }}>No 2B entry</div>
          )}
        </div>
      </div>

      {/* Variance bar */}
      <div className="px-6 py-3 border-t" style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium" style={{ color: 'var(--text-1)' }}>
            {explainText}
          </div>
          {match.itc_at_risk != null && match.itc_at_risk > 0 && (
            <span className="text-sm font-semibold font-mono" style={{ color: '#DC2626' }}>
              ITC at risk: ₹{Number(match.itc_at_risk).toLocaleString('en-IN')}
            </span>
          )}
        </div>
        {/* Evidence chips */}
        {evidence && Object.keys(evidence).length > 0 && (
          <div className="flex gap-2 mt-2">
            {evidence.extraction_confidence != null && (
              <span className="text-xs px-2 py-0.5 rounded" style={{ background: '#D1FAE5', color: '#065F46' }}>
                Read at {Math.round(Number(evidence.extraction_confidence) * 100)}% confidence
              </span>
            )}
            {evidence.alias_hit === true && (
              <span className="text-xs px-2 py-0.5 rounded" style={{ background: '#DBEAFE', color: '#1E40AF' }}>
                Alias confirmed
              </span>
            )}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="px-6 py-4 border-t flex items-center gap-3" style={{ borderColor: 'var(--border)' }}>
        {/* Accept */}
        <div className="relative">
          <button
            onClick={() => setShowAcceptPicker(!showAcceptPicker)}
            disabled={loading}
            className="px-4 py-2 rounded-lg text-sm font-semibold font-display text-white disabled:opacity-50"
            style={{ background: '#059669' }}
          >
            Accept
          </button>
          {showAcceptPicker && (
            <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border z-10 py-1" style={{ borderColor: 'var(--border)' }}>
              {REASON_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => handleAccept(opt.value)}
                  className="block w-full text-left px-4 py-2 text-sm hover:bg-slate-50 transition-colors">
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Flag */}
        <div className="relative">
          <button
            onClick={() => setShowFlagInput(!showFlagInput)}
            disabled={loading}
            className="px-4 py-2 rounded-lg text-sm font-semibold font-display disabled:opacity-50 border"
            style={{ borderColor: '#D97706', color: '#92400E', background: '#FEF3C7' }}
          >
            Flag to client
          </button>
          {showFlagInput && (
            <div className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-lg border z-10 p-3" style={{ borderColor: 'var(--border)', width: 280 }}>
              <textarea
                value={flagNote}
                onChange={e => setFlagNote(e.target.value)}
                placeholder="Why is this flagged?"
                className="w-full text-sm border rounded px-3 py-2 mb-2 resize-none"
                rows={3}
                style={{ borderColor: 'var(--border)' }}
              />
              <div className="flex gap-2">
                <button onClick={handleFlag} disabled={!flagNote.trim() || loading}
                  className="px-3 py-1.5 rounded text-xs font-semibold text-white disabled:opacity-50"
                  style={{ background: '#D97706' }}>Send</button>
                <button onClick={() => { setShowFlagInput(false); setFlagNote('') }}
                  className="px-3 py-1.5 rounded text-xs font-semibold" style={{ color: 'var(--text-3)' }}>Cancel</button>
              </div>
            </div>
          )}
        </div>

        {/* Mismatched fields */}
        {match.mismatched_fields && match.mismatched_fields.length > 0 && (
          <div className="ml-auto flex gap-1">
            {match.mismatched_fields.map(f => (
              <span key={f} className="inline-block px-1.5 py-0.5 rounded text-xs font-mono" style={{ background: '#FEE2E2', color: '#991B1B' }}>{f}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FieldRow({ label, value, mono, right }: { label: string; value: string | number | null | undefined; mono?: boolean; right?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs" style={{ color: 'var(--text-3)' }}>{label}</span>
      <span className={`text-sm font-medium ${mono ? 'font-mono text-xs' : ''}`}
        style={{ color: 'var(--text-1)', textAlign: right ? 'right' : undefined }}>
        {String(value ?? '—')}
      </span>
    </div>
  )
}
