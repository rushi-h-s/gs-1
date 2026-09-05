import { createClient } from '@/utils/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const DEV_ORG_ID = process.env.DEV_ORG_ID

function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/** Returns the db client and orgId for the current request, falling back to admin+DEV_ORG_ID when unauthenticated. */
export async function getDbAndOrg() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const db = user ? supabase : adminClient()
  const orgId = user
    ? (await supabase.from('org_members').select('org_id').eq('user_id', user.id).single()).data?.org_id
    : DEV_ORG_ID
  return { db, orgId: orgId as string | undefined }
}
