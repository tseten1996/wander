import * as React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { PageLoader } from '@/components/ui/misc'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import HomePage from '@/features/trips/HomePage'
import JoinPage from '@/features/join/JoinPage'
import TripLayout from '@/components/layout/TripLayout'

// The shell + home load eagerly; every feature page is its own chunk.
const Dashboard = React.lazy(() => import('@/features/dashboard/DashboardPage'))
const MyTrip = React.lazy(() => import('@/features/me/MePage'))
const Polls = React.lazy(() => import('@/features/polls/PollsPage'))
const Dates = React.lazy(() => import('@/features/dates/DatesPage'))
const Chat = React.lazy(() => import('@/features/messages/ChatPage'))
const Questions = React.lazy(() => import('@/features/questions/QuestionsPage'))
const Checklist = React.lazy(() => import('@/features/checklist/ChecklistPage'))
const Itinerary = React.lazy(() => import('@/features/itinerary/ItineraryPage'))
const Budget = React.lazy(() => import('@/features/budget/BudgetPage'))
const Packing = React.lazy(() => import('@/features/packing/PackingPage'))
const Calendar = React.lazy(() => import('@/features/calendar/CalendarPage'))
const Notes = React.lazy(() => import('@/features/notes/NotesPage'))
const Inspiration = React.lazy(() => import('@/features/inspiration/InspirationPage'))
const Photos = React.lazy(() => import('@/features/photos/PhotosPage'))
const Settings = React.lazy(() => import('@/features/settings/SettingsPage'))
const PrintSummary = React.lazy(() => import('@/features/settings/PrintSummaryPage'))
const PublicItinerary = React.lazy(() => import('@/features/share/PublicItineraryPage'))
const PublicRecap = React.lazy(() => import('@/features/share/RecapPage'))

export default function App() {
  return (
    <ErrorBoundary>
      <React.Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/join/:code" element={<JoinPage />} />
          {/* Public read-only itinerary share (#127). Deliberately OUTSIDE
              TripLayout and the auth-gated flow: an outsider with no session and
              no membership reaches it through a share token alone. */}
          <Route path="/p/:token" element={<PublicItinerary />} />
          {/* Public read-only post-trip recap share (#238, epic #205). Like the
              itinerary share above: OUTSIDE TripLayout and the auth-gated flow —
              an outsider with no session reaches it through a share token alone. */}
          <Route path="/r/:token" element={<PublicRecap />} />
          <Route path="/trip/:tripId" element={<TripLayout />}>
            <Route index element={<Dashboard />} />
            <Route path="me" element={<MyTrip />} />
            <Route path="polls" element={<Polls />} />
            <Route path="dates" element={<Dates />} />
            <Route path="chat" element={<Chat />} />
            <Route path="questions" element={<Questions />} />
            <Route path="checklist" element={<Checklist />} />
            <Route path="itinerary" element={<Itinerary />} />
            <Route path="budget" element={<Budget />} />
            <Route path="packing" element={<Packing />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="notes" element={<Notes />} />
            <Route path="ideas" element={<Inspiration />} />
            <Route path="photos" element={<Photos />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="/trip/:tripId/print" element={<PrintSummary />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </React.Suspense>
    </ErrorBoundary>
  )
}
