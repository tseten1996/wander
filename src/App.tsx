import * as React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { PageLoader } from '@/components/ui/misc'
import HomePage from '@/features/trips/HomePage'
import JoinPage from '@/features/join/JoinPage'
import TripLayout from '@/components/layout/TripLayout'

// The shell + home load eagerly; every feature page is its own chunk.
const Dashboard = React.lazy(() => import('@/features/dashboard/DashboardPage'))
const Polls = React.lazy(() => import('@/features/polls/PollsPage'))
const Chat = React.lazy(() => import('@/features/messages/ChatPage'))
const Questions = React.lazy(() => import('@/features/questions/QuestionsPage'))
const Checklist = React.lazy(() => import('@/features/checklist/ChecklistPage'))
const Itinerary = React.lazy(() => import('@/features/itinerary/ItineraryPage'))
const Budget = React.lazy(() => import('@/features/budget/BudgetPage'))
const Packing = React.lazy(() => import('@/features/packing/PackingPage'))
const Calendar = React.lazy(() => import('@/features/calendar/CalendarPage'))
const Notes = React.lazy(() => import('@/features/notes/NotesPage'))
const Inspiration = React.lazy(() => import('@/features/inspiration/InspirationPage'))
const Settings = React.lazy(() => import('@/features/settings/SettingsPage'))
const PrintSummary = React.lazy(() => import('@/features/settings/PrintSummaryPage'))

export default function App() {
  return (
    <React.Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/join/:code" element={<JoinPage />} />
        <Route path="/trip/:tripId" element={<TripLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="polls" element={<Polls />} />
          <Route path="chat" element={<Chat />} />
          <Route path="questions" element={<Questions />} />
          <Route path="checklist" element={<Checklist />} />
          <Route path="itinerary" element={<Itinerary />} />
          <Route path="budget" element={<Budget />} />
          <Route path="packing" element={<Packing />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="notes" element={<Notes />} />
          <Route path="ideas" element={<Inspiration />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="/trip/:tripId/print" element={<PrintSummary />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </React.Suspense>
  )
}
