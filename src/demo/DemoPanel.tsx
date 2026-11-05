import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Clock, MonitorPlay, RotateCcw, SquareStack, X } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { cn } from '@/lib/utils'
import { become, jumpTo, lagosDay, lagosMinutes, resetDemo, thisFriday } from './control'
import { AMAKA, BISI, NGOZI, PEOPLE, PERSONAS, type Person } from './people'
import { giveTask, knockOn } from './sim'

/**
 * The presenter's controls, floating over the office so the office itself stays
 * exactly as it is. Be anyone, move the clock, make something happen, or follow the
 * tour. Collapses to a small pill; press Shift+D to hide it altogether.
 */
const TIMES: { label: string; minutes: number; note: string; friday?: boolean }[] = [
  { label: '09:15', minutes: 555, note: 'Sign-in opens' },
  { label: '11:05', minutes: 665, note: 'Sign-in closed, flags' },
  { label: '15:10', minutes: 910, note: 'Midday report' },
  { label: '17:30', minutes: 1050, note: 'End-of-day report' },
  { label: '19:10', minutes: 1150, note: 'Day closed, HR summary' },
  { label: 'Fri 19:10', minutes: 1150, note: 'Week closes, leaderboard', friday: true },
]

interface Stop {
  title: string
  say: string
  person: Person
  route: string
  minutes?: number
}

const TOUR: Stop[] = [
  { title: 'The floor', say: 'This is Ngozi, the CEO. Everyone’s door is here: who is in, who is away and what they are working on. It changes as people work.', person: NGOZI, route: '/office' },
  { title: 'Sign in for the day', say: 'Now Amaka, a team member. She is not in the office until she files her sign-in, and the server’s clock decides if it is on time.', person: AMAKA, route: '/office' },
  { title: 'Knock on a door', say: 'Knock on anyone’s door. They accept or say “not now”, and you get a private one-hour chat. Use “Someone knocks” below to see it from the other side.', person: AMAKA, route: '/office' },
  { title: 'Tasks', say: 'Tasks go from given to started to done to approved, with proof and stars. Give one to a colleague and watch them pick it up.', person: NGOZI, route: '/tasks' },
  { title: 'The team’s reports', say: 'HR sees every report side by side, with who was late and who missed one. Nothing here is automatic judgement: it is a starting point for a conversation.', person: BISI, route: '/reports' },
  { title: 'Leaderboard', say: 'Points come from approved tasks and on-time reports, whatever the job. It rewards work, not a tab left open.', person: AMAKA, route: '/leaderboard' },
  { title: 'New: Insights', say: 'The month added up for leadership, in plain words, with every figure traceable to the records.', person: NGOZI, route: '/insights' },
  { title: 'New: Notices', say: 'Post something the whole team must read, and see exactly who has. Post one and watch the count climb.', person: NGOZI, route: '/notices' },
  { title: 'New: Time off', say: 'Ask, decide, done. Approval pauses that person’s reports and shows on their door, so nobody enters anything twice.', person: BISI, route: '/time-off' },
  { title: 'New: Rooms', say: 'Book a room with no double bookings, and step in so the team can see who is in the meeting.', person: AMAKA, route: '/rooms' },
  { title: 'New: Team chat', say: 'Open channels for the whole team, next to the private knock chats. Post in Wins and someone will answer.', person: AMAKA, route: '/chat' },
  { title: 'The day closes', say: 'Jump to the evening. Anyone who missed a report is flagged, HR gets the summary, and the Email log shows every email that would have gone out.', person: BISI, route: '/email-log', minutes: 1150 },
]

function useClock() {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000)
    return () => clearInterval(t)
  }, [])
  const m = lagosMinutes()
  const day = new Date(`${lagosDay()}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  return `${day}, ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

const section = 'text-[11px] font-bold tracking-[0.06em] text-text-muted uppercase'
const chip = 'press hairline rounded-full bg-surface px-3 py-1.5 text-[12px] font-semibold text-text-primary transition-colors duration-150 hover:bg-surface-sunken disabled:opacity-50 max-sm:py-2.5'

export function DemoPanel() {
  const navigate = useNavigate()
  const location = useLocation()
  const profile = useAuthStore((s) => s.profile)
  const showToast = useToastStore((s) => s.showToast)
  const clock = useClock()
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stop, setStop] = useState<number | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const asked = useRef(false)
  const pill = useRef<HTMLButtonElement>(null)
  const closer = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  // Focus follows the panel: into it on opening, back to the pill on closing.
  useEffect(() => {
    if (open) closer.current?.focus()
    else if (wasOpen.current) pill.current?.focus()
    wasOpen.current = open
  }, [open])

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try {
      await fn()
      if (done) showToast(done, 'success')
    } catch (e) {
      console.error(e)
      showToast(e instanceof Error ? e.message : 'That did not work.', 'error')
    } finally {
      setBusy(false)
    }
  }

  const beAndGo = (p: Person, route = '/office') =>
    act(async () => {
      await become(p)
      navigate(route)
    })

  // A second window opened from here says who to be.
  useEffect(() => {
    if (asked.current) return
    asked.current = true
    const as = new URLSearchParams(location.search).get('as')
    const p = PEOPLE.find((x) => x.id === as)
    if (p) void beAndGo(p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)
      if (e.shiftKey && e.key.toLowerCase() === 'd' && !typing) setHidden((v) => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const goStop = (i: number) => {
    const s = TOUR[i]
    void act(async () => {
      await become(s.person)
      if (s.minutes) await jumpTo(s.minutes)
      navigate(s.route)
      // Only now: a stop that failed must not say it is showing.
      setStop(i)
    })
  }

  if (hidden) return null

  
  if (!open) {
    return (
      <button
        ref={pill}
        type="button"
        onClick={() => setOpen(true)}
        title="Open the presenter's controls (Shift+D hides this)"
        aria-label="Open the presenter's controls"
        className="press fixed top-[4.5rem] right-3 z-40 flex size-11 items-center justify-center gap-2 rounded-full bg-[var(--sidebar-bg)] text-[13px] font-bold text-white shadow-[var(--shadow-sm)] ring-1 ring-white/15 md:top-3 md:right-auto md:left-1/2 md:z-[70] md:h-10 md:w-auto md:-translate-x-1/2 md:px-4"
      >
        <MonitorPlay size={15} aria-hidden />
        <span className="max-md:hidden">Demo</span>
        <span className="tnum font-medium opacity-75 max-md:hidden">{clock.split(', ')[1]}</span>
      </button>
    )
  }

  const current = stop === null ? null : TOUR[stop]

  return (
    <aside
      onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      aria-label="Presenter's controls"
      className="hairline fixed top-[4.5rem] right-3 z-[70] flex max-h-[calc(100dvh-9.5rem)] w-[min(360px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-[18px] bg-surface-raised shadow-[0_18px_50px_rgba(0,0,0,0.28)] md:top-3 md:right-auto md:left-1/2 md:max-h-[min(90dvh,720px)] md:-translate-x-1/2"
    >
      <header className="on-dark flex items-center gap-2 bg-[var(--sidebar-bg)] px-4 py-3 text-white">
        <MonitorPlay size={16} aria-hidden />
        <div className="mr-auto min-w-0">
          <p className="text-[13px] font-bold">Presenter’s controls</p>
          <p className="tnum flex items-center gap-1 text-[12px] opacity-80">
            <Clock size={11} aria-hidden /> {clock} at the office
          </p>
        </div>
        <button ref={closer} type="button" onClick={() => setOpen(false)} aria-label="Close the controls" className="press rounded-full p-1.5 hover:bg-white/10 max-sm:p-3">
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className="min-w-0 space-y-4 overflow-y-auto p-4">
        <section className="hairline rounded-[14px] bg-surface p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-bold text-text-primary">{current ? `Tour ${stop! + 1} of ${TOUR.length}: ${current.title}` : 'Guided tour'}</h2>
            {current ? (
              <button type="button" onClick={() => setStop(null)} className="px-2 py-1 text-[12px] text-text-muted underline underline-offset-2 max-sm:min-h-11">
                End
              </button>
            ) : null}
          </div>
          <p className="mt-1 text-[13px] leading-snug text-text-secondary">
            {current ? current.say : `${TOUR.length} stops, with what to say at each. It switches person and page for you.`}
          </p>
          <div className="mt-2 flex gap-2">
            {current ? (
              <button type="button" disabled={busy || stop === 0} onClick={() => goStop(stop! - 1)} className={chip}>
                Back
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy || stop === TOUR.length - 1}
              onClick={() => goStop(stop === null ? 0 : stop + 1)}
              className="press rounded-full bg-forest px-4 py-1.5 text-[12px] font-bold text-ivory disabled:opacity-50 max-sm:py-2.5"
            >
              {current ? 'Next' : 'Start the tour'}
            </button>
          </div>
        </section>

        <section>
          <h2 className={section}>Be someone</h2>
          <ul className="mt-1.5 space-y-1">
            {PERSONAS.map(({ person, blurb }) => (
              <li key={person.id}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void beAndGo(person)}
                  aria-current={profile?.id === person.id || undefined}
                  className={cn('press w-full rounded-[10px] px-2.5 py-1.5 text-left transition-colors duration-150 hover:bg-[var(--hover)]', profile?.id === person.id && 'bg-[var(--tint-brand)]')}
                >
                  <span className="block text-[13px] font-semibold text-text-primary">{person.name}</span>
                  <span className="block text-[12px] text-text-muted">{blurb}</span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => window.open(`/?as=${profile?.id === AMAKA.id ? NGOZI.id : AMAKA.id}`, '_blank', 'width=1200,height=820')}
            className={cn(chip, 'mt-2 inline-flex items-center gap-1.5 max-md:hidden')}
          >
            <SquareStack size={13} aria-hidden /> Open a second window as {profile?.id === AMAKA.id ? 'Ngozi' : 'Amaka'}
          </button>
          <p className="mt-1 text-[12px] text-text-muted max-md:hidden">Put them side by side and knock from one to the other.</p>
        </section>

        <section>
          <h2 className={section}>Move the clock</h2>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            {TIMES.map((t) => (
              <button
                key={t.label}
                type="button"
                disabled={busy}
                onClick={() => void act(() => (t.friday ? jumpTo(t.minutes, thisFriday()) : jumpTo(t.minutes)), `It is now ${t.label}.`)}
                className="press hairline rounded-[10px] bg-surface p-2 text-left transition-colors duration-150 hover:bg-surface-sunken disabled:opacity-50"
              >
                <span className="tnum block text-[13px] font-bold text-text-primary">{t.label}</span>
                <span className="block text-[11px] leading-tight text-text-muted">{t.note}</span>
              </button>
            ))}
          </div>
        </section>

        {profile ? (
          <section>
            <h2 className={section}>Make something happen</h2>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <button type="button" disabled={busy} className={chip} onClick={() => void act(async () => showToast(`${await knockOn(profile.id)} is at your door.`, 'info'))}>
                Someone knocks
              </button>
              <button type="button" disabled={busy} className={chip} onClick={() => void act(async () => showToast(`${await giveTask(profile.id)} gave you a task.`, 'info'))}>
                A task comes in
              </button>
            </div>
          </section>
        ) : null}

        <section className="hairline-t pt-3">
          {confirmReset ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto text-[13px] text-text-secondary">Back to the start of the story?</p>
              <button type="button" className={chip} onClick={() => setConfirmReset(false)}>
                Keep going
              </button>
              <button type="button" disabled={busy} className="press rounded-full bg-[#8c2f22] px-3 py-1.5 text-[12px] font-bold text-white max-sm:py-2.5" onClick={() => void act(resetDemo)}>
                {busy ? 'Resetting…' : 'Reset'}
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmReset(true)} className={cn(chip, 'inline-flex items-center gap-1.5')}>
              <RotateCcw size={13} aria-hidden /> Reset the demo
            </button>
          )}
          <p className="mt-2 text-[11px] leading-snug text-text-muted">
            Sample company, sample people. Runs entirely in this browser: nothing is sent anywhere.
          </p>
          <button type="button" onClick={() => setHidden(true)} className="mt-1 py-1 text-[12px] text-text-muted underline underline-offset-2 max-sm:min-h-11">
            Hide the controls (Shift+D brings them back)
          </button>
        </section>
      </div>
    </aside>
  )
}
