'use client'

import { useState, useTransition } from 'react'
import { confirmEntry, updateAndConfirmEntry, skipEntry } from './actions'

interface Entry {
  id: string
  supplier_gstin: string | null
  inv_no: string | null
  inv_date: string | null
  taxable_value: number | null
  cgst: number | null
  sgst: number | null
  igst: number | null
  extraction_confidence: number | null
}

export function ConfirmForm({ entry, clientId, remaining }: { entry: Entry; clientId: string; remaining: number }) {
  const isBlank = !entry.supplier_gstin && !entry.inv_no
  const [editing, setEditing] = useState(isBlank)
  const [fields, setFields] = useState({
    supplier_gstin: entry.supplier_gstin ?? '',
    inv_no: entry.inv_no ?? '',
    inv_date: entry.inv_date ?? '',
    taxable_value: entry.taxable_value ?? 0,
    cgst: entry.cgst ?? 0,
    sgst: entry.sgst ?? 0,
    igst: entry.igst ?? 0,
  })
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const conf = entry.extraction_confidence ?? 0
  const bucket = conf >= 0.8 ? { label: 'High confidence', color: '#059669', bg: '#D1FAE5' }
    : conf >= 0.5 ? { label: 'Medium confidence', color: '#D97706', bg: '#FEF3C7' }
    : { label: 'Low confidence', color: '#DC2626', bg: '#FEE2E2' }

  function run(fn: () => Promise<void>) {
    setError(null)
    startTransition(async () => {
      try { await fn() } catch (e) { setError((e as Error).message) }
    })
  }

  return (
    <div className="max-w-xl bg-white rounded-2xl border p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold">{isBlank ? 'Enter Invoice Details' : 'Confirm Invoice'}</h2>
          <p className="text-sm" style={{ color: 'var(--text-3)' }}>
            {isBlank ? 'Extraction found nothing — enter fields manually.' : `${remaining} invoices need confirmation`}
          </p>
        </div>
        <span className="px-2 py-1 rounded text-xs font-semibold" style={{ background: bucket.bg, color: bucket.color }}>
          {bucket.label} ({conf.toFixed(2)})
        </span>
      </div>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      <div className="bg-gray-50 rounded-xl p-4 mb-6">
        {editing ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Supplier GSTIN">
              <input className="input-mono" value={fields.supplier_gstin}
                onChange={e => setFields(f => ({ ...f, supplier_gstin: e.target.value }))} />
            </Field>
            <Field label="Invoice No">
              <input className="input-mono" value={fields.inv_no}
                onChange={e => setFields(f => ({ ...f, inv_no: e.target.value }))} />
            </Field>
            <Field label="Invoice Date">
              <input type="date" className="input-mono" value={fields.inv_date}
                onChange={e => setFields(f => ({ ...f, inv_date: e.target.value }))} />
            </Field>
            <Field label="Taxable Value">
              <input type="number" className="input-right" value={fields.taxable_value}
                onChange={e => setFields(f => ({ ...f, taxable_value: Number(e.target.value) }))} />
            </Field>
            <Field label="CGST">
              <input type="number" className="input-right" value={fields.cgst}
                onChange={e => setFields(f => ({ ...f, cgst: Number(e.target.value) }))} />
            </Field>
            <Field label="SGST">
              <input type="number" className="input-right" value={fields.sgst}
                onChange={e => setFields(f => ({ ...f, sgst: Number(e.target.value) }))} />
            </Field>
            <Field label="IGST">
              <input type="number" className="input-right" value={fields.igst}
                onChange={e => setFields(f => ({ ...f, igst: Number(e.target.value) }))} />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Row label="Supplier GSTIN" value={entry.supplier_gstin ?? '—'} mono />
            <Row label="Invoice No" value={entry.inv_no ?? '—'} mono />
            <Row label="Invoice Date" value={entry.inv_date ?? '—'} />
            <Row label="Taxable" value={fmt(entry.taxable_value)} right />
            <Row label="CGST" value={fmt(entry.cgst)} right />
            <Row label="SGST" value={fmt(entry.sgst)} right />
            <Row label="IGST" value={fmt(entry.igst)} right />
          </div>
        )}
      </div>

      <div className="space-y-3">
        {editing ? (
          <>
            <button disabled={isPending || !fields.supplier_gstin || !fields.inv_no}
              onClick={() => run(() => updateAndConfirmEntry(entry.id, clientId, fields))}
              className="w-full py-2 px-4 rounded-lg text-sm font-semibold disabled:opacity-50"
              style={{ background: '#059669', color: '#fff' }}
              title={!fields.supplier_gstin || !fields.inv_no ? 'GSTIN and Invoice No are required' : undefined}>
              {isPending ? 'Saving…' : 'Save & Confirm'}
            </button>
            <button disabled={isPending} onClick={() => setEditing(false)}
              className="w-full py-2 px-4 rounded-lg text-sm font-medium text-gray-600 hover:opacity-70">
              Cancel
            </button>
          </>
        ) : (
          <>
            <button disabled={isPending}
              onClick={() => run(() => confirmEntry(entry.id, clientId))}
              className="w-full py-2 px-4 rounded-lg text-sm font-semibold disabled:opacity-50"
              style={{ background: '#059669', color: '#fff' }}>
              {isPending ? 'Confirming…' : 'Confirm'}
            </button>
            <button disabled={isPending} onClick={() => setEditing(true)}
              className="w-full py-2 px-4 rounded-lg text-sm font-semibold disabled:opacity-50"
              style={{ background: '#FEF3C7', color: '#92400E' }}>
              Edit & Confirm
            </button>
            <button disabled={isPending}
              onClick={() => run(() => skipEntry(entry.id, clientId))}
              className="w-full py-2 px-4 rounded-lg text-sm font-medium text-gray-500 hover:opacity-70 disabled:opacity-50">
              {isPending ? '…' : 'Skip'}
            </button>
          </>
        )}
      </div>

      <style>{`
        .input-mono { width:100%; padding:4px 6px; border:1px solid #d1d5db; border-radius:6px; font-size:12px; font-family:monospace; }
        .input-right { width:100%; padding:4px 6px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; text-align:right; }
      `}</style>
    </div>
  )
}

function fmt(v: number | null) {
  return v != null ? Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'
}

function Row({ label, value, mono, right }: { label: string; value: string; mono?: boolean; right?: boolean }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="font-medium" style={{ color: 'var(--text-3)' }}>{label}</span>
      <span className={mono ? 'font-mono text-xs' : ''} style={{ textAlign: right ? 'right' : undefined }}>{value}</span>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium" style={{ color: 'var(--text-3)' }}>{label}</label>
      {children}
    </div>
  )
}
