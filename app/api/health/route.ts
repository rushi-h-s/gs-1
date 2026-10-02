import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * Public liveness check for the host and the keep-alive pinger. It runs one tiny query so the
 * free Supabase project counts as active (free projects pause after ~7 days without activity).
 * Returns no data, only ok / not ok.
 */
export async function GET() {
  try {
    const { error } = await adminClient().from('orgs').select('id', { head: true, count: 'exact' }).limit(1)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 })
  }
}
