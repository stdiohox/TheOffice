import '@/demo/clock'
import { StrictMode, Suspense, lazy, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { AppShell } from '@/components/layout/AppShell'
import { AdminRoute, ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { Login } from '@/pages/Login'
import { SetPassword } from '@/pages/SetPassword'
import { useAuthStore } from '@/stores/authStore'
import { queryClient } from '@/lib/queryClient'
import { bootDemo } from '@/demo/boot'
import { DemoPanel } from '@/demo/DemoPanel'
import { EmptyState, Skeleton } from '@/components/ui/primitives'

// The office is where everyone lands; reports, tasks and settings load on first visit.
const Office = lazy(() => import('@/pages/Office').then((m) => ({ default: m.Office })))
const Reports = lazy(() => import('@/pages/Reports').then((m) => ({ default: m.Reports })))
const Tasks = lazy(() => import('@/pages/Tasks').then((m) => ({ default: m.Tasks })))
const Leaderboard = lazy(() => import('@/pages/Leaderboard').then((m) => ({ default: m.Leaderboard })))
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.Settings })))
const Notices = lazy(() => import('@/pages/Notices').then((m) => ({ default: m.Notices })))
const TimeOff = lazy(() => import('@/pages/TimeOff').then((m) => ({ default: m.TimeOff })))
const Rooms = lazy(() => import('@/pages/Rooms').then((m) => ({ default: m.Rooms })))
const TeamChat = lazy(() => import('@/pages/TeamChat').then((m) => ({ default: m.TeamChat })))
const Insights = lazy(() => import('@/pages/Insights').then((m) => ({ default: m.Insights })))
const EmailLog = lazy(() => import('@/pages/EmailLog').then((m) => ({ default: m.EmailLog })))


/** Shaped like the page it stands in for, so the chunk arriving is not a jump. */
function RouteFallback() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-6 p-6 lg:p-8">
      <Skeleton className="h-[46px] w-[220px]" />
      <Skeleton className="h-[176px]" />
    </div>
  )
}

function NotFound() {
  return (
    <EmptyState
      title="That page does not exist"
      body="The link may be out of date."
      action={
        <Link
          to="/office"
          className="press inline-flex h-10 items-center rounded-full border border-line bg-surface-raised px-5 text-sm font-semibold text-text-primary hover:bg-surface-sunken"
        >
          Go to the office
        </Link>
      }
    />
  )
}

function App() {
  const initialize = useAuthStore((s) => s.initialize)
  useEffect(() => {
    void initialize()
  }, [initialize])

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* The link in an invite or a reset email lands here. */}
      <Route path="/set-password" element={<SetPassword />} />
      <Route
        element={
          <ProtectedRoute>
            <AppShell />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Navigate to="/office" replace />} />
        <Route
          path="/office"
          element={
            <Suspense fallback={<RouteFallback />}>
              <Office />
            </Suspense>
          }
        />
        <Route
          path="/reports"
          element={
            <Suspense fallback={<RouteFallback />}>
              <Reports />
            </Suspense>
          }
        />
        <Route
          path="/leaderboard"
          element={
            <Suspense fallback={<RouteFallback />}>
              <Leaderboard />
            </Suspense>
          }
        />
        <Route
          path="/tasks"
          element={
            <Suspense fallback={<RouteFallback />}>
              <Tasks />
            </Suspense>
          }
        />
        <Route
          path="/notices"
          element={
            <Suspense fallback={<RouteFallback />}>
              <Notices />
            </Suspense>
          }
        />
        <Route
          path="/time-off"
          element={
            <Suspense fallback={<RouteFallback />}>
              <TimeOff />
            </Suspense>
          }
        />
        <Route
          path="/rooms"
          element={
            <Suspense fallback={<RouteFallback />}>
              <Rooms />
            </Suspense>
          }
        />
        <Route
          path="/chat"
          element={
            <Suspense fallback={<RouteFallback />}>
              <TeamChat />
            </Suspense>
          }
        />
        <Route
          path="/insights"
          element={
            <Suspense fallback={<RouteFallback />}>
              <Insights />
            </Suspense>
          }
        />
        <Route
          path="/email-log"
          element={
            <Suspense fallback={<RouteFallback />}>
              <EmailLog />
            </Suspense>
          }
        />
        <Route
          path="/settings"
          element={
            <AdminRoute>
              <Suspense fallback={<RouteFallback />}>
                <Settings />
              </Suspense>
            </AdminRoute>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

void bootDemo().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
          <DemoPanel />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  )
})
