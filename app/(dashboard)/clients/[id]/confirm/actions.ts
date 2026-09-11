'use server'

import { getDbAndOrg } from '@/lib/db'
import { revalidatePath } from 'next/cache'
import { normalizeGstin, normalizeInvNo } from '@/lib/normalize'

export async function confirmEntry(entryId: string, clientId: string) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) throw new Error('No org')
  const { data: { user } } = await db.auth.getUser()

  await db.from('purchase_register_entries')
    .update({ needs_confirmation: false, confirmed_at: new Date().toISOString(), confirmed_by: user?.id ?? null })
    .eq('id', entryId)
    .eq('org_id', orgId)

  revalidatePath(`/clients/${clientId}/confirm`)
}

export async function updateAndConfirmEntry(
  entryId: string,
  clientId: string,
  fields: {
    supplier_gstin: string
    inv_no: string
    inv_date: string
    taxable_value: number
    cgst: number
    sgst: number
    igst: number
  }
) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) throw new Error('No org')
  const { data: { user } } = await db.auth.getUser()

  await db.from('purchase_register_entries')
    .update({
      supplier_gstin: fields.supplier_gstin,
      norm_supplier_gstin: fields.supplier_gstin ? normalizeGstin(fields.supplier_gstin) : null,
      inv_no: fields.inv_no,
      norm_inv_no: fields.inv_no ? normalizeInvNo(fields.inv_no) : null,
      inv_date: fields.inv_date || null,
      taxable_value: fields.taxable_value,
      cgst: fields.cgst,
      sgst: fields.sgst,
      igst: fields.igst,
      needs_confirmation: false,
      confirmed_at: new Date().toISOString(),
      confirmed_by: user?.id ?? null,
    })
    .eq('id', entryId)
    .eq('org_id', orgId)

  revalidatePath(`/clients/${clientId}/confirm`)
}

export async function skipEntry(entryId: string, clientId: string) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) throw new Error('No org')

  // Mark confirmed without correction so it doesn't block the queue
  await db.from('purchase_register_entries')
    .update({ needs_confirmation: false, confirmed_at: new Date().toISOString() })
    .eq('id', entryId)
    .eq('org_id', orgId)

  revalidatePath(`/clients/${clientId}/confirm`)
}
