import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  // Resend signs webhooks — validate in production
  const payload = await req.json()

  const supabase = await createClient()

  const fromEmail = payload.from as string
  const attachments = (payload.attachments ?? []) as Array<{ filename: string; content: string }>

  if (!attachments.length) return NextResponse.json({ ok: true, skipped: 'no attachments' })

  // Lookup routing rule by sender email
  const { data: routing } = await supabase
    .from('email_routing')
    .select('client_id, org_id')
    .eq('match_from_email', fromEmail)
    .single()

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
