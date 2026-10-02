import { NextResponse } from 'next/server'
import { getDbAndOrg } from '@/lib/db'
import { normalizeGstin, validateGstin } from '@/lib/normalize'

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

  const body = await req.json().catch(() => null)
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const gstin = typeof body?.gstin === 'string' ? normalizeGstin(body.gstin) : ''
  if (!name || !gstin) return NextResponse.json({ error: 'name and gstin required' }, { status: 400 })
  if (!validateGstin(gstin)) return NextResponse.json({ error: 'Invalid GSTIN — must be 15 characters in the standard format' }, { status: 400 })

  const { data, error } = await db.from('clients').insert({ org_id: orgId, name, gstin }).select().single()
  // 23505 = unique violation. ponytail: clients.gstin is unique across ALL orgs in the DB; make it (org_id, gstin) in a migration.
  if (error?.code === '23505') return NextResponse.json({ error: 'A client with this GSTIN already exists' }, { status: 409 })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data, { status: 201 })
}
