import type { SupabaseClient } from '@supabase/supabase-js'

interface ToolCtx {
  db: SupabaseClient
  orgId: string
  client_id: string
  period: string
}

async function findBreak(db: SupabaseClient, orgId: string, client_id: string, period: string, invoiceNo: string) {
  const norm = invoiceNo.replace(/\s+/g, '').toUpperCase().replace(/^0+/, '')
  // Try PR side first, then 2B side
  const { data: pr } = await db
    .from('purchase_register_entries')
    .select('id, supplier_gstin, norm_inv_no, invoice_number, taxable_value, cgst, sgst, igst')
    .eq('org_id', orgId).eq('client_id', client_id).eq('period', period)
    .eq('norm_inv_no', norm)
    .limit(1)
    .single()
  const { data: tb } = await db
    .from('gstr2b_entries')
    .select('id, supplier_gstin, norm_inv_no, invoice_number, taxable_value, cgst, sgst, igst')
    .eq('org_id', orgId).eq('client_id', client_id).eq('period', period)
    .eq('norm_inv_no', norm)
    .limit(1)
    .single()

  const prId = (pr as { id?: string } | null)?.id ?? null
  const tbId = (tb as { id?: string } | null)?.id ?? null
  if (!prId && !tbId) return null

  let q = db
    .from('match_results')
    .select('id, status, confidence, mismatched_fields, taxable_variance, tax_variance, itc_at_risk, user_status, resolution_reason, resolution_note, evidence')
    .eq('org_id', orgId).eq('client_id', client_id).eq('period', period)
  q = prId ? q.eq('pr_entry_id', prId) : q.eq('gstr2b_entry_id', tbId!)
  const { data: match } = await q.limit(1).single()
  return { pr, tb, match }
}

export async function runTool(
  name: string,
  args: Record<string, string>,
  ctx: ToolCtx,
) {
  const { db, orgId, client_id, period } = ctx

  if (name === 'explain_mismatch') {
    const found = await findBreak(db, orgId, client_id, period, args.invoice_no)
    if (!found) return { error: `Invoice ${args.invoice_no} not found in books or 2B for ${period}` }
    return found
  }

  if (name === 'draft_vendor_email') {
    const found = await findBreak(db, orgId, client_id, period, args.invoice_no)
    if (!found) return { error: `Invoice ${args.invoice_no} not found for ${period}` }
    return { invoice: found, vendor_gstin: args.vendor_gstin, mismatch_type: args.mismatch_type }
  }

  if (name === 'summarise_reconciliation') {
    const { data: run } = await db
      .from('recon_run')
      .select('status, totals, created_at')
      .eq('org_id', orgId).eq('client_id', client_id).eq('period', args.period)
      .order('created_at', { ascending: false })
      .limit(1)
      .single()
    const { data: rows } = await db
      .from('match_results')
      .select('status, user_status')
      .eq('org_id', orgId).eq('client_id', client_id).eq('period', args.period)
    const counts = (rows ?? []).reduce<Record<string, number>>((acc: Record<string, number>, r: { status: string }) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1
      return acc
    }, {})
    const open = (rows ?? []).filter((r: { user_status: string }) => r.user_status === 'unreviewed').length
    return { period: args.period, counts, open, run }
  }

  return { error: `Unknown tool: ${name}` }
}
