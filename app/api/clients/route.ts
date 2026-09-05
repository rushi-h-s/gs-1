import { NextResponse } from 'next/server'
import { getDbAndOrg } from '@/lib/db'

export async function GET() {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return NextResponse.json([])

  const { data, error } = await db.from('clients').select('*').eq('org_id', orgId).order('name')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

export async function POST(req: Request) {
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

  const { name, gstin } = await req.json()
  if (!name || !gstin) return NextResponse.json({ error: 'name and gstin required' }, { status: 400 })

  const { data, error } = await db.from('clients').insert({ org_id: orgId, name, gstin }).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
