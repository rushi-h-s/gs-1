'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/utils/supabase/client'

const NAV = [
  {
    href: '/',
    label: 'Clients',
    match: (p: string) => p === '/' || p.startsWith('/clients'),
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
    ),
  },
  {
    href: '/clients/new',
    label: 'Add Client',
    match: (p: string) => p === '/clients/new',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>
    ),
  },
]

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [email, setEmail] = useState<string | null>(null)
  useEffect(() => {
    createClient().auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null))
  }, [])

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--color-bg)', color: 'var(--color-text)' }}>
      {/* Sidebar — Filewise */}
      <aside className="w-60 shrink-0 flex flex-col" style={{ background: 'var(--color-surface)', borderRight: '2px solid var(--color-divider)' }}>
        {/* Brand */}
        <div style={{ padding: '20px 20px 16px', borderBottom: '2px solid var(--color-divider)' }}>
          <Link href="/">
            <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 19, letterSpacing: '-0.01em' }}>
              Filewise
            </div>
            <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9e3526', marginTop: 2 }}>
              GST Practice Manager
            </div>
          </Link>
        </div>

        {/* Nav */}
        <nav style={{ display: 'flex', flexDirection: 'column', padding: '12px 10px', gap: 2, flex: 1 }}>
          {NAV.map(item => {
            const active = item.match(pathname)
            return (
              <Link
                key={item.href}
                href={item.href}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '10px 14px', fontSize: 14,
                  fontFamily: 'var(--font-display)', fontWeight: 600,
                  background: active ? '#ffe0d9' : 'transparent',
                  color: active ? '#7c1405' : 'var(--color-text)',
                }}
              >
                {item.icon}
                {item.label}
              </Link>
            )
          })}
        </nav>

        {/* User footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderTop: '2px solid var(--color-divider)' }}>
          <div style={{ width: 32, height: 32, flex: 'none', background: 'var(--color-accent)', color: 'var(--color-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 13 }}>
            {(email ?? 'CA').slice(0, 2).toUpperCase()}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {email ?? 'Practice Owner'}
            </div>
            <form action="/api/auth/signout" method="post">
              <button type="submit" style={{ fontSize: 11, opacity: 0.7, textDecoration: 'underline', background: 'none', border: 0, padding: 0, cursor: 'pointer' }}>
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <main className="flex-1 px-9 py-7" style={{ maxWidth: 1240 }}>
          {children}
        </main>
      </div>
    </div>
  )
}
