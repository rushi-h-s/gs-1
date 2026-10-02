import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/utils/supabase/middleware'

// Reachable without a session. The webhook authenticates itself with a shared secret.
const PUBLIC = ['/login', '/api/email-inbound', '/api/health']
const devBypass = process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === 'true'

export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request)
  const { pathname, search } = request.nextUrl

  if (devBypass) return response

  const isPublic = PUBLIC.some(p => pathname === p || pathname.startsWith(p + '/'))

  if (!user && !isPublic) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
    }
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/login') {
    const next = request.nextUrl.searchParams.get('next')
    const safe = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
    return NextResponse.redirect(new URL(safe, request.url))
  }

  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
