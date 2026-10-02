import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const supabase = await createClient()
  await supabase.auth.signOut()
  // 303 so the browser follows with GET (a 307 would re-POST to /login)
  return NextResponse.redirect(new URL('/login', req.url), 303)
}
