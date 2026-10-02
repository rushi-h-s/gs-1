import type { User } from '@supabase/supabase-js'
import { createClient } from '@/utils/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

const DEV_ORG_ID = process.env.DEV_ORG_ID

/**
 * Local-dev escape hatch ONLY: skip login and act as DEV_ORG_ID through the service-role key.
 * Needs DEV_AUTH_BYPASS=true and is hard-disabled in production builds.
 */
export const devBypass = process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === 'true'

export function adminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

/**
 * First sign-in: make sure the user has an org. In dev, a user adopts the seeded DEV_ORG_ID
 * if nobody owns it yet (keeps existing test data); otherwise a fresh org is created.
 * ponytail: two simultaneous first requests can create two orgs; add a unique(owner_id) if that bites.
 */
async function provisionOrg(user: User): Promise<string | undefined> {
  const admin = adminClient()

  let orgId: string | undefined
  if (process.env.NODE_ENV !== 'production' && DEV_ORG_ID) {
    const { count } = await admin.from('org_members').select('user_id', { count: 'exact', head: true }).eq('org_id', DEV_ORG_ID)
    if (count === 0) orgId = DEV_ORG_ID
  }
  if (!orgId) {
    const { data: owned } = await admin.from('orgs').select('id').eq('owner_id', user.id).limit(1).maybeSingle()
    orgId = owned?.id
  }
  if (!orgId) {
    const { data: org, error } = await admin.from('orgs')
      .insert({ name: `${user.email ?? 'My'} firm`, owner_id: user.id }).select('id').single()
    if (error || !org) {
      console.error('org provisioning failed:', error?.message)
      return undefined
    }
    orgId = org.id
  }
  const { error } = await admin.from('org_members').upsert({ org_id: orgId, user_id: user.id, role: 'admin' })
  if (error) {
    console.error('membership provisioning failed:', error.message)
    return undefined
  }
  return orgId
}

/**
 * The db client + org for the current request.
 * Signed in  -> RLS-scoped user client; org auto-provisioned on first use.
 * Signed out -> orgId undefined (callers return 401/403) unless the dev bypass is on.
 */
export async function getDbAndOrg() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    if (devBypass) return { db: adminClient(), orgId: DEV_ORG_ID as string | undefined, user: null }
    return { db: supabase, orgId: undefined as string | undefined, user: null }
  }

  const { data: member } = await supabase.from('org_members').select('org_id').eq('user_id', user.id).limit(1).maybeSingle()
  const orgId = member?.org_id ?? (await provisionOrg(user))
  return { db: supabase, orgId: orgId as string | undefined, user }
}

type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>

/**
 * Supabase silently truncates every select at 1000 rows. This pages through a query until
 * it is exhausted. Pass a factory so each page gets a fresh builder:
 *   fetchAll(() => db.from('t').select('*').eq('a', 1).order('id'))   // order => stable pages
 */
export async function fetchAll<T>(
  build: () => { range(from: number, to: number): Page<T> },
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < pageSize) return out
  }
}

/** Insert/update/delete in slices so one huge request can't hit body or URL limits. */
export async function inChunks<T>(items: T[], size: number, fn: (slice: T[]) => PromiseLike<{ error: { message: string } | null }>) {
  for (let i = 0; i < items.length; i += size) {
    const { error } = await fn(items.slice(i, i + size))
    if (error) throw new Error(error.message)
  }
}
