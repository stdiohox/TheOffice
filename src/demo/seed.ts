import { NOTICE_VERSION } from '@/lib/officeNotice'
import { asOwner, type Tx } from './engine'
import { AMAKA, BISI, CHINEDU, DAYO, IFE, KEMI, LATE_STARTERS, NGOZI, PASSWORD, PEOPLE, SEGUN, TUNDE, WORK, ZAINAB, type Person } from './people'

/**
 * The sample month, written straight into the tables with triggers off: the same
 * rows the office's functions would have left behind, dated back from today. Same
 * start, same story every time (a seeded random), so a rehearsal matches the room.
 */
const ZONE_OFFSET = '+01:00'
const FILERS = PEOPLE.filter((p) => p !== NGOZI)
/** Not signed in yet this morning: Amaka so the presenter can do it, Chinedu to raise the missed flag. */
const NOT_IN_TODAY = new Set(LATE_STARTERS.map((p) => p.id))
const AWAY_TODAY = KEMI.id

function rng(seed: number) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const at = (day: string, minutes: number) => `${day}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00${ZONE_OFFSET}`
const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const isWorkday = (day: string) => ![0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay())

/** The last n workdays before `today`, oldest first. */
function workdaysBefore(today: string, n: number) {
  const out: string[] = []
  for (let d = addDays(today, -1); out.length < n; d = addDays(d, -1)) if (isWorkday(d)) out.unshift(d)
  return out
}

const pick = <T,>(r: () => number, list: T[]) => list[Math.floor(r() * list.length)]

async function bulk(tx: Tx, table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return
  // Every row's keys, not the first row's: a column only later rows set must not vanish.
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].map((c) => `"${c}"`).join(', ')
  await tx.query(`insert into ${table} (${cols}) select ${cols} from jsonb_populate_recordset(null::${table}, $1::jsonb)`, [JSON.stringify(rows)])
}

export async function wipe(tx: Tx) {
  await tx.exec(`
    truncate public.office_channel_messages, public.office_room_occupants, public.office_bookings,
      public.office_leave_requests, public.office_notice_reads, public.office_notices,
      public.office_task_events, public.office_task_files, public.office_tasks,
      public.office_chat_messages, public.office_knocks, public.office_checkins, public.office_activity_state,
      public.office_day_notes, public.office_day_starts, public.office_entries, public.office_presence, public.office_status,
      public.office_flags, public.office_report_files, public.office_reports, public.office_absences,
      public.office_notice_acks, public.office_onboarding, public.office_alert_log, public.office_members, public.invites,
      demo.outbox, demo.tokens, demo.blobs, demo.changes cascade;
    update public.office_settings set manager_id = null where id = 1;
    delete from storage.objects;
    delete from public.profiles;
    delete from auth.users;
  `)
}

export async function seed(today: string, minutesNow: number) {
  await asOwner(async (tx) => {
    await tx.exec(`set local session_replication_role = replica`)
    await wipe(tx)
    await write(tx, today, minutesNow)
  })
}

async function write(tx: Tx, today: string, minutesNow: number) {
  const r = rng(20261104)
  const days = workdaysBefore(today, 20)
  const start = at(days[0], 8 * 60)
  const last = days[days.length - 1]
  const lastWeek = days.slice(-5)

  await bulk(tx, 'auth.users', PEOPLE.map((p) => ({ id: p.id, email: p.email, encrypted_password: PASSWORD, email_confirmed_at: start, created_at: start })))
  await bulk(tx, 'public.profiles', PEOPLE.map((p) => ({ id: p.id, email: p.email, full_name: p.name, role: p.role, job_title: p.title, created_at: start })))
  await bulk(tx, 'public.office_members', PEOPLE.map((p) => ({ user_id: p.id, active: true, added_at: start })))
  await tx.query(`update public.office_settings set manager_id = $1 where id = 1`, [NGOZI.id])
  await bulk(tx, 'public.office_notice_acks', PEOPLE.map((p) => ({ user_id: p.id, version: NOTICE_VERSION, acked_at: start })))
  await bulk(tx, 'public.office_onboarding', PEOPLE.flatMap((p) => ['door', 'notifications'].map((task) => ({ user_id: p.id, task, done_at: start }))))

  // Days away.
  const dayoAway = lastWeek[1]
  const absences = [
    { user_id: DAYO.id, starts_on: dayoAway, ends_on: lastWeek[2], reason: 'Annual leave', created_by: BISI.id },
    { user_id: KEMI.id, starts_on: today, ends_on: today, reason: 'Sick leave', created_by: BISI.id },
    { user_id: SEGUN.id, starts_on: days[4], ends_on: days[5], reason: 'Personal leave', created_by: BISI.id },
  ]
  await bulk(tx, 'public.office_absences', absences)
  const isAway = (id: string, day: string) => absences.some((a) => a.user_id === id && day >= a.starts_on && day <= a.ends_on)

  // Reports, stays, presence and flags for each past workday.
  const reports: Record<string, unknown>[] = []
  const flags: Record<string, unknown>[] = []
  const entries: Record<string, unknown>[] = []
  const presence: Record<string, unknown>[] = []
  for (const day of days) {
    for (const p of FILERS) {
      if (isAway(p.id, day)) continue
      const work = WORK[p.beat]
      // Chinedu runs later than the others, so the insights have someone to point at.
      const lateChance = p === CHINEDU ? 0.3 : 0.05
      const missChance = p === CHINEDU ? 0.12 : 0.02
      const late = r() < lateChance
      const signinAt = late ? 665 + Math.floor(r() * 50) : 545 + Math.floor(r() * 105)
      reports.push({ user_id: p.id, work_date: day, kind: 'signin', body: pick(r, work.signin), submitted_at: at(day, signinAt), timing: late ? 'late' : 'on_time' })
      if (late) flags.push({ user_id: p.id, work_date: day, kind: 'signin', flag: 'late', detail: `${pad(Math.floor(signinAt / 60))}:${pad(signinAt % 60)}`, raised_at: at(day, signinAt), notified_at: at(day, signinAt + 5) })
      const middayMissed = r() < missChance
      if (middayMissed) flags.push({ user_id: p.id, work_date: day, kind: 'midday', flag: 'missed', raised_at: at(day, 16 * 60 + 5), notified_at: at(day, 16 * 60 + 6) })
      else reports.push({ user_id: p.id, work_date: day, kind: 'midday', body: pick(r, work.midday), submitted_at: at(day, 905 + Math.floor(r() * 50)), timing: 'on_time' })
      const eodMissed = r() < missChance
      const eodAt = 1040 + Math.floor(r() * 90)
      if (eodMissed) flags.push({ user_id: p.id, work_date: day, kind: 'eod', flag: 'missed', raised_at: at(day, 19 * 60 + 5), notified_at: at(day, 19 * 60 + 6) })
      else reports.push({ user_id: p.id, work_date: day, kind: 'eod', body: pick(r, work.eod), submitted_at: at(day, eodAt), links: r() < 0.3 ? ['https://docs.example.com/brightwork/update'] : null, timing: 'on_time' })

      entries.push({ user_id: p.id, work_date: day, entered_at: at(day, signinAt), entered_by: 'signin', left_at: at(day, eodAt + 4), left_reason: 'eod' })
      const lunch = 750 + Math.floor(r() * 45)
      const back = lunch + 30 + Math.floor(r() * 25)
      presence.push({ user_id: p.id, status: 'online', started_at: at(day, signinAt), last_seen_at: at(day, lunch) })
      presence.push({ user_id: p.id, status: 'away', started_at: at(day, lunch), last_seen_at: at(day, back) })
      presence.push({ user_id: p.id, status: r() < 0.25 ? 'busy' : 'online', started_at: at(day, back), last_seen_at: at(day, eodAt + 4) })
    }
  }

  // This morning, up to the clock.
  const status: Record<string, unknown>[] = []
  for (const p of FILERS) {
    if (p.id === AWAY_TODAY || NOT_IN_TODAY.has(p.id)) continue
    const when = 545 + Math.floor(r() * Math.max(30, Math.min(100, minutesNow - 560)))
    reports.push({ user_id: p.id, work_date: today, kind: 'signin', body: pick(r, WORK[p.beat].signin), submitted_at: at(today, when), timing: 'on_time' })
    entries.push({ user_id: p.id, work_date: today, entered_at: at(today, when), entered_by: 'signin' })
    status.push({ user_id: p.id, working_on: pick(r, WORK[p.beat].doing), set_on: today, updated_at: at(today, when + 2) })
  }
  status.push({ user_id: NGOZI.id, working_on: WORK.lead.doing[0], set_on: today, updated_at: at(today, 540) })
  status.push({ user_id: KEMI.id, out_until: today, set_on: today, updated_at: at(today, 500) })
  await bulk(tx, 'public.office_reports', reports)
  await bulk(tx, 'public.office_flags', flags)
  await bulk(tx, 'public.office_entries', entries)
  await bulk(tx, 'public.office_presence', presence)
  await bulk(tx, 'public.office_status', status)

  // Tasks: most of them closed and rated, a live handful for today.
  const tasks: Record<string, unknown>[] = []
  const events: Record<string, unknown>[] = []
  const staff = [AMAKA, SEGUN, IFE, KEMI, DAYO, CHINEDU, ZAINAB, BISI]
  const taskId = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  let n = 0
  const givers = [NGOZI, TUNDE]
  const closedNotes = ['Done, details in the link.', 'Finished and shared with the team.', 'Complete. Happy to walk through it.', 'All sorted.']
  const ratingNotes = ['Thorough work, thank you.', 'Quick turnaround.', 'Exactly what was needed.', null, null]
  for (const day of days) {
    const count = 1 + Math.floor(r() * 2)
    for (let i = 0; i < count; i++) {
      const to = pick(r, staff)
      if (isAway(to.id, day)) continue
      const by = pick(r, givers)
      const id = taskId(++n)
      const created = at(day, 570 + Math.floor(r() * 120))
      const started = at(day, 700 + Math.floor(r() * 60))
      const doneDay = days[Math.min(days.indexOf(day) + (r() < 0.5 ? 0 : 1), days.length - 1)]
      const doneAt = at(doneDay, 900 + Math.floor(r() * 120))
      const closedAt = at(doneDay, 1030 + Math.floor(r() * 20))
      const stars = r() < 0.75 ? 5 - Math.floor(r() * r() * 3) : null
      const note = closedNotes[n % closedNotes.length]
      tasks.push({
        id, title: pick(r, WORK[to.beat].tasks), assigned_by: by.id, assigned_to: to.id, due_on: addDays(day, 2), status: 'approved',
        done_note: note, done_at: doneAt, closed_at: closedAt, closed_by: by.id, created_at: created, updated_at: closedAt,
        rating: stars, rating_note: stars ? ratingNotes[n % ratingNotes.length] : null, rated_by: stars ? by.id : null, rated_at: stars ? closedAt : null,
      })
      events.push({ task_id: id, actor: by.id, kind: 'assigned', created_at: created, emailed_at: created })
      events.push({ task_id: id, actor: to.id, kind: 'started', created_at: started })
      events.push({ task_id: id, actor: to.id, kind: 'done', note, created_at: doneAt, emailed_at: doneAt })
      events.push({ task_id: id, actor: by.id, kind: 'approved', created_at: closedAt, emailed_at: closedAt })
      if (stars) events.push({ task_id: id, actor: by.id, kind: 'rated', note: `${stars} stars`, created_at: closedAt })
    }
  }
  const live = (to: Person, by: Person, title: string, details: string, st: string, dueIn: number, extra: Record<string, unknown> = {}) => {
    const id = taskId(++n)
    const created = at(last, 600)
    tasks.push({ id, title, details, assigned_by: by.id, assigned_to: to.id, due_on: addDays(today, dueIn), status: st, done_note: null, done_at: null, closed_at: null, closed_by: null, created_at: created, updated_at: created, rating: null, rating_note: null, rated_by: null, rated_at: null, ...extra })
    events.push({ task_id: id, actor: by.id, kind: 'assigned', created_at: created, emailed_at: created })
    if (st !== 'open') events.push({ task_id: id, actor: to.id, kind: 'started', created_at: at(last, 660) })
    if (st === 'done') events.push({ task_id: id, actor: to.id, kind: 'done', note: String(extra.done_note ?? ''), created_at: String(extra.done_at), emailed_at: String(extra.done_at) })
    return id
  }
  live(AMAKA, NGOZI, 'Write the November newsletter', 'Lead with the customer webinar. Kemi has the images.', 'open', 1)
  live(AMAKA, TUNDE, 'Report on the referral campaign', 'Sign-ups, cost per sign-up and what to change next month.', 'in_progress', 2)
  live(IFE, NGOZI, 'Send the retail client proposal', 'Use the new pricing table. Copy me when it goes.', 'done', 0, { done_note: 'Sent this morning. They will reply by Friday.', done_at: at(today, 610), done_links: ['https://docs.example.com/brightwork/proposal'] })
  live(DAYO, NGOZI, 'Complete the month-end close', 'Finance pack to me by Friday.', 'in_progress', 2)
  live(SEGUN, TUNDE, 'Update the refund help article', 'New seven-day policy.', 'done', 0, { done_note: 'Updated and published.', done_at: at(today, 625) })
  live(CHINEDU, TUNDE, 'Finish the monthly stock count', 'Was due yesterday. Tell me what is blocking it.', 'in_progress', -1)
  live(ZAINAB, NGOZI, 'Fix the checkout timeout', 'Customers are dropping at the payment step.', 'in_progress', 1)
  live(BISI, NGOZI, 'Schedule the quarterly reviews', 'One hour each, all before month end.', 'open', 3)
  live(CHINEDU, CHINEDU, 'Clear my expense receipts', 'A note to myself.', 'open', 4)
  await bulk(tx, 'public.office_tasks', tasks)
  await bulk(tx, 'public.office_task_events', events)

  // A knock from yesterday, with its chat.
  const knock = 'c0000000-0000-4000-8000-000000000001'
  await bulk(tx, 'public.office_knocks', [{ id: knock, from_user: IFE.id, to_user: DAYO.id, status: 'accepted', created_at: at(last, 660), expires_at: at(last, 662), responded_at: at(last, 660), ended_at: at(last, 672) }])
  await bulk(tx, 'public.office_chat_messages', [
    { knock_id: knock, sender: IFE.id, body: 'Has the Adebayo invoice cleared yet?', created_at: at(last, 661) },
    { knock_id: knock, sender: DAYO.id, body: 'Yes, this morning. Receipt is in the shared folder.', created_at: at(last, 662) },
  ])

  // What the demo adds.
  const notice = (i: number) => `d0000000-0000-4000-8000-${String(i).padStart(12, '0')}`
  await bulk(tx, 'public.office_notices', [
    { id: notice(1), title: 'New leave policy from 1 December', body: 'Annual leave now carries over for up to five days. Please read the summary and press "I have read this" so we know everyone has seen it. Bisi can answer any questions.', pinned: true, needs_read: true, author: BISI.id, created_at: at(last, 600) },
    { id: notice(2), title: 'Customer webinar on Thursday, 3pm', body: 'The whole team is welcome. Amaka is hosting and will send the running order on Wednesday.', pinned: false, needs_read: false, author: NGOZI.id, created_at: at(lastWeek[3], 540) },
    { id: notice(3), title: 'A very good October', body: 'We closed the month 12% ahead of plan. Thank you all. Lunch is on the company next Friday.', pinned: false, needs_read: false, author: NGOZI.id, created_at: at(lastWeek[0], 1000) },
  ])
  await bulk(tx, 'public.office_notice_reads', [
    ...[NGOZI, TUNDE, BISI, SEGUN, IFE, DAYO, ZAINAB].map((p) => ({ notice_id: notice(1), user_id: p.id, read_at: at(last, 640) })),
    ...PEOPLE.map((p) => ({ notice_id: notice(3), user_id: p.id, read_at: at(lastWeek[0], 1010) })),
  ])
  await bulk(tx, 'public.office_leave_requests', [
    { user_id: SEGUN.id, kind: 'annual', starts_on: addDays(today, 7), ends_on: addDays(today, 9), note: 'Family wedding in Enugu.', status: 'pending', created_at: at(last, 900) },
    { user_id: ZAINAB.id, kind: 'personal', starts_on: addDays(today, 3), ends_on: addDays(today, 3), note: 'Visa appointment.', status: 'pending', created_at: at(today, 560) },
    { user_id: DAYO.id, kind: 'annual', starts_on: dayoAway, ends_on: lastWeek[2], status: 'approved', decided_by: BISI.id, decided_at: at(lastWeek[0], 600), created_at: at(lastWeek[0], 570) },
    { user_id: KEMI.id, kind: 'sick', starts_on: today, ends_on: today, note: 'Not feeling well, back tomorrow.', status: 'approved', decided_by: BISI.id, decided_at: at(today, 510), created_at: at(today, 490) },
    { user_id: IFE.id, kind: 'annual', starts_on: addDays(today, 14), ends_on: addDays(today, 18), status: 'declined', decided_by: BISI.id, decided_at: at(last, 700), decision_note: 'Clashes with the quarter-end push. Could you take the week after?', created_at: at(last, 650) },
  ])
  const slot = (minutes: number) => at(today, minutes)
  await bulk(tx, 'public.office_bookings', [
    { room_id: 'boardroom', title: 'Weekly leadership meeting', starts_at: slot(minutesNow + 30), ends_at: slot(minutesNow + 90), booked_by: NGOZI.id },
    { room_id: 'focus', title: 'Checkout fix review', starts_at: slot(minutesNow - 20), ends_at: slot(minutesNow + 25), booked_by: ZAINAB.id },
    { room_id: 'corner', title: 'One-to-one: Bisi and Chinedu', starts_at: slot(900), ends_at: slot(930), booked_by: BISI.id },
    { room_id: 'boardroom', title: 'Sales pipeline review', starts_at: slot(960), ends_at: slot(1020), booked_by: IFE.id },
  ])
  await bulk(tx, 'public.office_room_occupants', [
    { user_id: ZAINAB.id, room_id: 'focus', joined_at: slot(minutesNow - 15) },
    { user_id: DAYO.id, room_id: 'focus', joined_at: slot(minutesNow - 12) },
  ])
  await bulk(tx, 'public.office_channel_messages', [
    { channel: 'general', sender: TUNDE.id, body: 'Good morning all. Courier collections move to 2pm today.', created_at: at(today, 545) },
    { channel: 'general', sender: IFE.id, body: 'Thanks Tunde. I will have the samples ready by 1.', created_at: at(today, 552) },
    { channel: 'general', sender: BISI.id, body: 'Reminder: please read the leave policy notice when you get a moment.', created_at: at(today, 575) },
    { channel: 'wins', sender: IFE.id, body: 'The retail proposal is out and they sounded very keen on the call.', created_at: at(today, 615) },
    { channel: 'wins', sender: NGOZI.id, body: 'Great work on October, everyone. 12% ahead of plan.', created_at: at(last, 1000) },
    { channel: 'wins', sender: ZAINAB.id, body: 'Release 2.3 went out with no rollbacks.', created_at: at(lastWeek[3], 950) },
    { channel: 'help', sender: SEGUN.id, body: 'Does anyone have the latest refund wording?', created_at: at(last, 840) },
    { channel: 'help', sender: AMAKA.id, body: 'It is in the help article draft. Sending the link now.', created_at: at(last, 844) },
  ])
}
