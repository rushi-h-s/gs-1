import { NextResponse } from 'next/server'
import { getDbAndOrg } from '@/lib/db'

export async function POST(req: Request) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

  const { client_id, period } = await req.json()
  if (!client_id || !period) return NextResponse.json({ error: 'client_id and period required' }, { status: 400 })

  // 1. Total ITC claimed = sum of all 2B tax values for the period
  const { data: twoB } = await db
    .from('gstr2b_entries')
    .select('cgst, sgst, igst')
    .eq('org_id', orgId)
    .eq('client_id', client_id)
    .eq('period', period)
  const totalItcClaimed = (twoB ?? []).reduce(
    (s: number, r: { cgst: number | null; sgst: number | null; igst: number | null }) =>
      s + Number(r.cgst ?? 0) + Number(r.sgst ?? 0) + Number(r.igst ?? 0),
    0,
  )

  // 2. ITC at risk = sum of match_results.itc_at_risk still unreviewed
  const { data: open } = await db
    .from('match_results')
    .select('itc_at_risk')
    .eq('org_id', orgId)
    .eq('client_id', client_id)
    .eq('period', period)
    .eq('user_status', 'unreviewed')
  const itcAtRisk = (open ?? []).reduce((s: number, r: { itc_at_risk: number | null }) => s + Number(r.itc_at_risk ?? 0), 0)

  // 3. ITC relieved + write-offs from ledger
  const { data: ledger } = await db
    .from('ledger_allocations')
    .select('allocation_type, itc_relieved')
    .eq('org_id', orgId)
    .eq('client_id', client_id)
    .eq('period', period)
  const itcRelieved = (ledger ?? []).reduce((s: number, r: { itc_relieved: number | null }) => s + Number(r.itc_relieved ?? 0), 0)
  const writeOffs = (ledger ?? [])
    .filter((r: { allocation_type: string | null }) => r.allocation_type === 'write_off')
    .reduce((s: number, r: { itc_relieved: number | null }) => s + Number(r.itc_relieved ?? 0), 0)

  const { error } = await db.from('period_snapshots').upsert(
    {
      org_id: orgId,
      client_id,
      period,
      total_itc_claimed: totalItcClaimed,
      itc_at_risk: itcAtRisk,
      itc_relieved: itcRelieved,
      write_offs_approved: writeOffs,
      net_itc_risk: itcAtRisk - itcRelieved,
    },
    { onConflict: 'org_id,client_id,period' },
  )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({
    success: true,
    total_itc_claimed: totalItcClaimed,
    itc_at_risk: itcAtRisk,
    itc_relieved: itcRelieved,
    net_itc_risk: itcAtRisk - itcRelieved,
  })
}
