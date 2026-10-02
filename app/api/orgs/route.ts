import { NextResponse } from 'next/server'
import { getDbAndOrg } from '@/lib/db'

export async function GET() {
  const { db, orgId, user } = await getDbAndOrg()
  if (!orgId) {
    return NextResponse.json({ error: user ? 'No org' : 'Not signed in' }, { status: user ? 403 : 401 })
  }
  const { data: org } = await db.from('orgs').select('id, name').eq('id', orgId).maybeSingle()
  return NextResponse.json({ org_id: orgId, orgs: org ?? { id: orgId, name: 'My firm' } })
}
