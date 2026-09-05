import { createClient } from '@/utils/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import Link from 'next/link'

const CONFIRMATION_BUCKETS = {
  HIGH:    { label: 'High confidence',     color: '#059669', bg: '#D1FAE5' },
  MEDIUM:  { label: 'Medium confidence',    color: '#D97706', bg: '#FEF3C7' },
  LOW:     { label: 'Low confidence',       color: '#DC2626', bg: '#FEE2E2' },
}

export default async function ConfirmationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const db = user ? supabase : createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Fetch client name for header
  const { data: clientRow } = await db.from('clients').select('name, gstin').eq('id', id).single()

  // Fetch unconfirmed entries ordered by confidence ascending (worst first)
  const { data: unconfirmed, error } = await db
    .from('purchase_register_entries')
    .select('id, supplier_gstin, norm_inv_no, taxable_value, cgst, sgst, igst, extraction_confidence, source, file_hash, created_at')
    .eq('client_id', id)
    .eq('needs_confirmation', true)
    .is('confirmed_at', null)
    .order('extraction_confidence', { ascending: true })

  if (error) {
    console.error('[confirmation page] query error:', error)
    return <div className="max-w-xl p-8">Error loading unconfirmed entries.</div>
  }

  const totalNeedsConfirm = unconfirmed?.length ?? 0

  // Find current entry index
  const currentIdx = unconfirmed?.findIndex((e: any) => e.confirmed_at === null) ?? 0
  const current = unconfirmed?.[currentIdx] ?? null

  // Update confirmed entry
  async function confirmEntry(entryId: string) {
    const { error: updError } = await db
      .from('purchase_register_entries')
      .update({ confirmed_at: new Date().toISOString(), confirmed_by: user?.id })
      .eq('id', entryId)

    if (updError) throw updError
    // Reload page
    const searchParams = new URLSearchParams(window.location.search)
    const newIdx = Math.min(currentIdx + 1, (unconfirmed?.length ?? 1) - 1)
    window.location.href = `/clients/${id}/confirm?idx=${newIdx}`
  }

  // Re-extract entry
  async function reExtractEntry(entryId: string) {
    // Trigger the edge function to re-extract
    // For now, just redirect back to upload
    window.location.href = `/clients/${id}`
  }

  if (!current) {
    return (
      <div className="max-w-xl p-8 bg-white rounded-2xl border">
        <h2 className="text-xl font-bold mb-4">No entries need confirmation</h2>
        <p className="text-muted-foreground">
          All {totalNeedsConfirm} invoices have been confirmed. <Link href={`/clients/${id}`}>Back to client</Link>
        </p>
      </div>
    )
  }

  const bucket = current.extraction_confidence != null
    ? current.extraction_confidence >= 0.8 ? 'HIGH'
      : current.extraction_confidence >= 0.5 ? 'MEDIUM'
      : 'LOW'
    : 'LOW'

  return (
    <div className="max-w-xl bg-white rounded-2xl border p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold">Confirm Invoice</h2>
          <p className="text-muted-foreground">
            {current.supplier_gstin ?? '—'} · {current.norm_inv_no ?? '—'} · {totalNeedsConfirm} invoices need confirmation
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded text-xs font-semibold"
            style={{ background: CONFIRMATION_BUCKETS[bucket].bg, color: CONFIRMATION_BUCKETS[bucket].color }}>
            {CONFIRMATION_BUCKETS[bucket].label}
          </span>
        </div>
      </div>

      {/* Entry details card */}
      <div className="bg-gray-50 rounded-xl p-4 mb-6">
        <div className="grid grid-cols-2 gap-4">
          <FieldRow label="Supplier GSTIN" value={String(current.supplier_gstin ?? '—')} mono />
          <FieldRow label="Invoice No" value={String(current.norm_inv_no ?? '—')} mono />
          <FieldRow label="Taxable" value={Number(current.taxable_value ?? 0).toLocaleString('en-IN')} right />
          <FieldRow label="CGST" value={Number(current.cgst ?? 0).toLocaleString('en-IN')} right />
          <FieldRow label="SGST" value={Number(current.sgst ?? 0).toLocaleString('en-IN')} right />
          <FieldRow label="IGST" value={Number(current.igst ?? 0).toLocaleString('en-IN')} right />
          <FieldRow label="Extraction conf." value={Number(current.extraction_confidence ?? 0).toFixed(2)} right />
          <FieldRow label="Source" value={String(current.source ?? 'upload')} />
          <FieldRow label="Created" value={new Date(current.created_at).toLocaleDateString('en-IN')} />
        </div>
      </div>

      {/* Action buttons */}
      <div className="space-y-3">
        <button
          onClick={() => confirmEntry(current!.id)}
          className="w-full py-2 px-4 rounded-lg text-sm font-medium font-semibold"
            style={{ background: '#059669', color: '#FFFFFF' }}>
          Confirm
        </button>
        <button
          onClick={() => reExtractEntry(current!.id)}
          className="w-full py-2 px-4 rounded-lg text-sm font-medium font-semibold"
            style={{ background: '#D97706', color: '#92400E' }}>
          Re-extract
        </button>
        <Link
          href={`/clients/${id}`}
          className="w-full py-2 px-4 rounded-lg text-sm font-medium text-muted-foreground hover:opacity-70"
        >
          Cancel
        </Link>
      </div>
    </div>
  )
}

function FieldRow({ label, value, mono, right }: { label: string; value: string | number | null | undefined; mono?: boolean; right?: boolean }) {
  const className = mono ? 'font-mono text-xs' : 'text-sm'
  const alignClass = right ? 'text-right' : ''
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="font-medium" style={{ color: 'var(--text-3)' }}>{label}</span>
      <span className={className} style={{ color: 'var(--text-1)' }}>
        {right ? value : String(value ?? '—')}
        {!right && value !== undefined && <span style={{ marginLeft: 10 }} />}
      </span>
    </div>
  )
}