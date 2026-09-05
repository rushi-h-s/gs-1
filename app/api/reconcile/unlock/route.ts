import { NextResponse } from 'next/server'
import { getDbAndOrg } from '@/lib/db'

export async function POST(req: Request) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

  const { client_id, period } = await req.json()
  if (!client_id || !period) return NextResponse.json({ error: 'client_id and period required' }, { status: 400 })

  const { error } = await db.from('locked_periods')
    .delete()
    .eq('org_id', orgId)
    .eq('client_id', client_id)
    .eq('period', period)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
