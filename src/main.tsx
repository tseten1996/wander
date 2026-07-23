import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { Toaster } from 'sonner'
import { AuthProvider } from '@/hooks/useAuth'
import { OfflineBanner } from '@/components/layout/OfflineBanner'
import { queryClient, persister, PERSIST_MAX_AGE, PERSIST_BUSTER } from '@/lib/queryClient'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE,
        buster: PERSIST_BUSTER,
        // Only persist settled, successful reads — never in-flight or errored
        // queries, so a failed offline fetch can't overwrite good cached data.
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => query.state.status === 'success',
        },
      }}
    >
      <AuthProvider>
        <HashRouter>
          <App />
        </HashRouter>
        <OfflineBanner />
        <Toaster
          position="top-center"
          toastOptions={{
            style: {
              background: 'var(--elevated)',
              color: 'var(--ink)',
              border: '1px solid var(--line)',
              borderRadius: '12px',
            },
          }}
        />
      </AuthProvider>
    </PersistQueryClientProvider>
  </React.StrictMode>
)
