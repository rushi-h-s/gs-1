import { NextResponse } from 'next/server'
import { getDbAndOrg } from '@/lib/db'

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { db, orgId } = await getDbAndOrg()
  if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

  const { error } = await db.from('clients').delete().eq('id', id).eq('org_id', orgId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { db, orgId } = await getDbAndOrg()
    if (!orgId) return NextResponse.json({ error: 'No org' }, { status: 403 })

    const { count } = await db.from('purchase_register_entries')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', id)
      .eq('org_id', orgId)
      .eq('needs_confirmation', true)
      .is('confirmed_at', null)

    return NextResponse.json({ count: count ?? 0 })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to count' }, { status: 500 })
  }
}
