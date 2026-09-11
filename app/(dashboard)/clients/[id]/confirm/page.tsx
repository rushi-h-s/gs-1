import { getDbAndOrg } from '@/lib/db'
import Link from 'next/link'
import { ConfirmForm } from './ConfirmForm'

export default async function ConfirmationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return <div className="p-8">Not authorised.</div>

  const { data: unconfirmed } = await db
    .from('purchase_register_entries')
    .select('id, supplier_gstin, inv_no, inv_date, taxable_value, cgst, sgst, igst, extraction_confidence')
    .eq('org_id', orgId)
    .eq('client_id', id)
    .eq('needs_confirmation', true)
    .is('confirmed_at', null)
    .order('extraction_confidence', { ascending: true })

  const current = unconfirmed?.[0] ?? null

  if (!current) {
    return (
      <div className="max-w-xl p-8 bg-white rounded-2xl border">
        <h2 className="text-xl font-bold mb-2">All caught up</h2>
        <p className="text-sm" style={{ color: 'var(--text-3)' }}>
          No invoices need confirmation. <Link href={`/clients/${id}`} className="underline">Back to client</Link>
        </p>
      </div>
    )
  }

  return (
    <div className="p-6">
      <div className="mb-4">
        <Link href={`/clients/${id}`} className="text-sm underline" style={{ color: 'var(--text-3)' }}>
          ← Back to client
        </Link>
      </div>
      <ConfirmForm entry={current} clientId={id} remaining={unconfirmed?.length ?? 1} />
    </div>
  )
}
