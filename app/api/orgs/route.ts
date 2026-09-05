import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'

// ponytail: dev-only bypass, remove when auth is re-enabled
const DEV_ORG_ID = process.env.DEV_ORG_ID

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ org_id: DEV_ORG_ID, orgs: { id: DEV_ORG_ID, name: 'Dev Org' } })
  }

  const { data } = await supabase
    .from('org_members')
    .select('org_id, orgs(id, name)')
    .eq('user_id', user.id)
    .single()

  return NextResponse.json(data)
}
