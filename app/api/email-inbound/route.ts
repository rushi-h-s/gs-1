import { NextResponse } from 'next/server'
import { adminClient } from '@/lib/db'

export async function POST(req: Request) {
  // Webhook has no user session, so it must prove itself with a shared secret.
  const secret = process.env.EMAIL_INBOUND_SECRET
  if (!secret) return NextResponse.json({ error: 'Inbound email not configured (set EMAIL_INBOUND_SECRET)' }, { status: 503 })
  if (req.headers.get('x-webhook-secret') !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const payload = await req.json().catch(() => null)
  if (!payload) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  // Service role: there is no signed-in user, and RLS would hide every routing row.
  const supabase = adminClient()

  const fromEmail = String(payload.from ?? '')
  const attachments = (payload.attachments ?? []) as Array<{ filename: string; content: string }>

  if (!attachments.length) return NextResponse.json({ ok: true, skipped: 'no attachments' })

  // Lookup routing rule by sender email
  const { data: routing } = await supabase
    .from('email_routing')
    .select('client_id, org_id')
    .eq('match_from_email', fromEmail)
    .limit(1)
    .maybeSingle()

  if (!routing) {
    console.warn('No routing rule for', fromEmail)
    return NextResponse.json({ ok: true, skipped: 'no routing rule' })
  }

  const period = new Date().toISOString().slice(0, 7) // default to current month YYYY-MM
  const results = []

  for (const attachment of attachments) {
    const { data, error } = await supabase.functions.invoke('extract-invoice', {
      body: {
        fileBytes: attachment.content,
        filename: attachment.filename,
        metadata: { client_id: routing.client_id, period, org_id: routing.org_id, file_hash: null },
      },
    })
    results.push({ filename: attachment.filename, ...(error ? { error: error.message } : data) })
  }

  return NextResponse.json({ ok: true, results })
}
