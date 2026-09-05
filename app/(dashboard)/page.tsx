import { createClient } from '@/utils/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import Link from 'next/link'

const DEV_ORG_ID = process.env.DEV_ORG_ID

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const db = user ? supabase : createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const orgId = user
    ? (await supabase.from('org_members').select('org_id').eq('user_id', user.id).single()).data?.org_id
    : DEV_ORG_ID

  const { data: clients } = await db
    .from('clients')
    .select('id, name, gstin')
    .eq('org_id', orgId)
    .order('name')

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="flex items-end justify-between mb-8">
        <div>
          <p className="text-xs font-semibold tracking-widest uppercase mb-1" style={{ color: 'var(--text-3)' }}>
            Your Practice
          </p>
          <h1 className="text-3xl font-bold font-display" style={{ color: 'var(--text-1)' }}>
            Clients
          </h1>
        </div>
        <Link
          href="/clients/new"
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white transition-colors font-display hover:opacity-90"
          style={{ background: 'var(--primary)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          Add Client
        </Link>
      </div>

      {/* Empty state */}
      {!clients?.length ? (
        <div className="bg-white rounded-2xl border p-16 text-center" style={{ borderColor: 'var(--border)' }}>
          <div className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4" style={{ background: 'var(--emerald-light)' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--emerald)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <p className="font-semibold font-display" style={{ color: 'var(--text-1)' }}>No clients yet</p>
          <p className="text-sm mt-1 mb-5" style={{ color: 'var(--text-3)' }}>Add your first client to start reconciling</p>
          <Link href="/clients/new" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-white font-display" style={{ background: 'var(--primary)' }}>
            Add Client
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {clients.map((client, i) => (
            <Link
              key={client.id}
              href={`/clients/${client.id}`}
              className="group bg-white rounded-xl border flex items-center px-5 py-4 transition-all hover:shadow-md hover:border-transparent"
              style={{ borderColor: 'var(--border)' }}
            >
              {/* Index */}
              <span className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold mr-4 shrink-0 font-display transition-colors"
                style={{ background: 'var(--bg)', color: 'var(--text-3)' }}>
                {String(i + 1).padStart(2, '0')}
              </span>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="font-semibold font-display text-sm" style={{ color: 'var(--text-1)' }}>
                  {client.name}
                </div>
                <div className="text-xs font-mono mt-0.5 tracking-wider" style={{ color: 'var(--text-3)' }}>
                  {client.gstin}
                </div>
              </div>

              {/* State indicator */}
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs px-2.5 py-1 rounded-full font-medium" style={{ background: 'var(--emerald-light)', color: 'var(--emerald)' }}>
                  Active
                </span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className="transition-transform group-hover:translate-x-0.5" style={{ color: 'var(--text-3)' }}>
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
