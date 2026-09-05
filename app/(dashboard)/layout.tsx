'use client'

import Link from 'next/link'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 flex flex-col" style={{ background: 'var(--navy)' }}>
        {/* Brand */}
        <div className="px-6 py-5 border-b" style={{ borderColor: 'var(--navy-border)' }}>
          <Link href="/" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded flex items-center justify-center text-white text-xs font-bold"
              style={{ background: 'var(--emerald)' }}>
              G
            </div>
            <span className="text-white font-semibold text-sm tracking-wide font-display">
              GST Engine
            </span>
          </Link>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          <NavItem href="/" label="Clients" icon={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          } />
        </nav>

        {/* Footer */}
        <div className="px-6 py-4 border-t" style={{ borderColor: 'var(--navy-border)' }}>
          <p className="text-xs" style={{ color: 'rgba(255,255,255,0.3)' }}>
            GST Reconciliation
          </p>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="bg-white border-b px-8 py-3.5 flex items-center justify-between shrink-0" style={{ borderColor: 'var(--border)' }}>
          <span className="text-xs font-medium tracking-widest uppercase" style={{ color: 'var(--text-3)' }}>
            GST Engine
          </span>
          <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-medium"
            style={{ background: 'var(--navy)' }}>
            CA
          </div>
        </header>

        <main className="flex-1 px-8 py-8">
          {children}
        </main>
      </div>
    </div>
  )
}

function NavItem({ href, label, icon }: { href: string; label: string; icon: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors"
      style={{ color: 'rgba(255,255,255,0.65)' }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.08)'
        ;(e.currentTarget as HTMLElement).style.color = 'white'
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = 'transparent'
        ;(e.currentTarget as HTMLElement).style.color = 'rgba(255,255,255,0.65)'
      }}
    >
      {icon}
      <span className="font-display font-medium">{label}</span>
    </Link>
  )
}
