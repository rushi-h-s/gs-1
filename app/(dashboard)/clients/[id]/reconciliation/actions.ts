'use server'

import { getDbAndOrg } from '@/lib/db'
import { revalidatePath } from 'next/cache'

export async function acceptMatch(id: string, reason: string, note?: string) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) throw new Error('No org')
  const { data: { user } } = await db.auth.getUser()

  const { data: current } = await db
    .from('match_results')
    .select('user_status, itc_at_risk, client_id, period')
    .eq('id', id)
    .eq('org_id', orgId)
    .single()

  await db.from('recon_audit').insert({
    match_result_id: id,
    action: 'accepted',
    old_status: current?.user_status ?? 'unreviewed',
    new_status: 'accepted',
    resolution_reason: reason,
    note: note ?? null,
    actor: user?.id ?? null,
    org_id: orgId,
  })

  const { error } = await db
    .from('match_results')
    .update({ user_status: 'accepted', resolution_reason: reason, resolution_note: note ?? null })
    .eq('id', id)
    .eq('org_id', orgId)

  if (error) throw error.message

  if (current) {
    await db.from('ledger_allocations').insert({
      org_id: orgId,
      client_id: current.client_id,
      period: current.period,
      match_result_id: id,
      allocation_type: reason,
      itc_relieved: current.itc_at_risk ?? 0,
      approved_by: user?.id ?? null,
    })
  }
  revalidatePath('/clients/[id]/reconciliation', 'page')
}

export async function flagMatch(id: string, note: string) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) throw new Error('No org')
  const { data: { user } } = await db.auth.getUser()

  // Fetch old status and write audit in one read, then update
  const { data: current } = await db
    .from('match_results')
    .select('user_status')
    .eq('id', id)
    .eq('org_id', orgId)
    .single()

  await db.from('recon_audit').insert({
    match_result_id: id,
    action: 'flagged',
    old_status: current?.user_status ?? 'unreviewed',
    new_status: 'flagged',
    resolution_reason: null,
    note,
    actor: user?.id ?? null,
    org_id: orgId,
  })

  const { error } = await db
    .from('match_results')
    .update({ user_status: 'flagged', resolution_note: note })
    .eq('id', id)
    .eq('org_id', orgId)

  if (error) throw error.message
  revalidatePath('/clients/[id]/reconciliation', 'page')
}

export async function repairMatch(id: string, newTwoBId: string) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) throw new Error('No org')
  const { data: { user } } = await db.auth.getUser()

  const { data: current } = await db
    .from('match_results')
    .select('user_status')
    .eq('id', id)
    .eq('org_id', orgId)
    .single()

  const { error } = await db
    .from('match_results')
    .update({ gstr2b_entry_id: newTwoBId, user_status: 'repaired', mismatched_fields: [] })
    .eq('id', id)
    .eq('org_id', orgId)

  if (error) throw error.message

  await db.from('recon_audit').insert({
    match_result_id: id,
    action: 'repaired',
    old_status: current?.user_status ?? 'unreviewed',
    new_status: 'repaired',
    resolution_reason: null,
    note: null,
    actor: user?.id ?? null,
    org_id: orgId,
  })

  revalidatePath('/clients/[id]/reconciliation', 'page')
}

export async function acceptAllMatched(runId: string) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) throw new Error('No org')
  const { data: { user } } = await db.auth.getUser()

  const { data: matched } = await db
    .from('match_results')
    .select('id, user_status')
    .eq('run_id', runId)
    .eq('status', 'MATCHED')
    .eq('org_id', orgId)

  if (matched?.length) {
    // Bulk audit insert — one call instead of N serial inserts
    await db.from('recon_audit').insert(
      matched.map(m => ({
        match_result_id: m.id,
        action: 'accepted',
        old_status: m.user_status,
        new_status: 'accepted',
        resolution_reason: 'auto_matched',
        note: null,
        actor: user?.id ?? null,
        org_id: orgId,
      }))
    )
  }

  const { error } = await db
    .from('match_results')
    .update({ user_status: 'accepted', resolution_reason: 'auto_matched' })
    .eq('run_id', runId)
    .eq('status', 'MATCHED')
    .eq('org_id', orgId)

  if (error) throw error.message
  revalidatePath('/clients/[id]/reconciliation', 'page')
}
