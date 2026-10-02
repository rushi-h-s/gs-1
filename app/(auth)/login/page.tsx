'use client'

import { useEffect, useState } from 'react'
import { Auth } from '@supabase/auth-ui-react'
import { ThemeSupa } from '@supabase/auth-ui-shared'
import { createClient } from '@/utils/supabase/client'

export default function LoginPage() {
  // One client for the page's lifetime (a new one per render re-subscribes auth listeners).
  const [supabase] = useState(() => createClient())

  useEffect(() => {
    const go = () => {
      const next = new URLSearchParams(window.location.search).get('next')
      // full navigation so the proxy sees the fresh session cookie; only same-site paths
      window.location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
    }
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') go()
    })
    return () => subscription.unsubscribe()
  }, [supabase])

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-md bg-white rounded-xl shadow p-8">
        <h1 className="text-2xl font-bold text-center mb-6 text-gray-800">Filewise — GST Practice Manager</h1>
        <Auth
          supabaseClient={supabase}
          appearance={{ theme: ThemeSupa }}
          providers={[]}
          redirectTo={typeof window !== 'undefined' ? `${window.location.origin}/` : undefined}
        />
      </div>
    </div>
  )
}
