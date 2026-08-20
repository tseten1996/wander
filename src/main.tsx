import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { LazyMotion, domAnimation, MotionConfig } from 'framer-motion'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { Toaster } from 'sonner'
import { AuthProvider } from '@/hooks/useAuth'
import { OfflineBanner } from '@/components/layout/OfflineBanner'
import { ScrollToTop } from '@/components/layout/ScrollToTop'
import { InstallNudge } from '@/components/layout/InstallNudge'
import { UpdateNudge } from '@/components/layout/UpdateNudge'
import { queryClient, persister, PERSIST_MAX_AGE, PERSIST_BUSTER } from '@/lib/queryClient'
import { initErrorReporting } from '@/lib/errorReporting'
import App from './App'
import './index.css'

// Register global error telemetry (#57) before the app mounts so a crash during
// the very first render still gets a chance to be reported.
initErrorReporting()

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
        {/* Honour the OS prefers-reduced-motion setting for every Framer Motion
            animation app-wide (#137). Framer's JS-driven animations bypass the
            CSS reduced-motion guard in index.css, so this is what actually
            suppresses transform/layout motion (entrance fade-ups, join card,
            trip cards) for motion-sensitive users. "user" keeps opacity/colour
            transitions, which carry no motion. */}
        <MotionConfig reducedMotion="user">
          {/* Load only framer-motion's `domAnimation` feature bundle (enter/exit
              + transforms — the only animations Wander uses) so the lightweight
              `m` components behind @/lib/motion animate without pulling the full
              `motion` proxy. See src/lib/motion.ts. */}
          <LazyMotion features={domAnimation}>
            <HashRouter>
              <ScrollToTop />
              <App />
            </HashRouter>
            <OfflineBanner />
            <InstallNudge />
            {/* Tells you when a newer build has claimed the page. The service
                worker is `autoUpdate`, so new assets arrive silently and the
                running page keeps the old code until something reloads — which
                is how a deployed, verified fix can appear not to exist. */}
            <UpdateNudge />
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
          </LazyMotion>
        </MotionConfig>
      </AuthProvider>
    </PersistQueryClientProvider>
  </React.StrictMode>
)
