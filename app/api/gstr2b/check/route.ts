import { NextResponse } from 'next/server'
import { getDbAndOrg } from '@/lib/db'

// GET /api/gstr2b/check?client_id=X&period=YYYY-MM
// Returns { exists: boolean, count: number }
export async function GET(req: Request) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const clientId = searchParams.get('client_id')
  const period = searchParams.get('period')
  if (!clientId || !period) return NextResponse.json({ error: 'client_id and period required' }, { status: 400 })

  const { count } = await db
    .from('gstr2b_entries')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('client_id', clientId)
    .eq('period', period)

  return NextResponse.json({ exists: (count ?? 0) > 0, count: count ?? 0 })
}
