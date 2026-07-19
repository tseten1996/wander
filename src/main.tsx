import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { AuthProvider } from '@/hooks/useAuth'
import App from './App'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,       // realtime invalidation keeps data fresh
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <HashRouter>
          <App />
        </HashRouter>
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
    </QueryClientProvider>
  </React.StrictMode>
)
