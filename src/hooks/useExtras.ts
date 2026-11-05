import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

/** The demo's additions to the office (0021): notices, time off, rooms, team chat, insights. */

export const extrasKeys = { all: ['extras'] as const }

function useExtra<T>(name: string, read: () => PromiseLike<{ data: unknown; error: { message: string } | null }>, enabled = true) {
  const signedIn = useAuthStore((s) => !!s.profile)
  return useQuery({
    queryKey: [...extrasKeys.all, name],
    enabled: signedIn && enabled,
    staleTime: 15_000,
    // A new date range or a jump of the clock keeps the old rows up until the new ones land.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { data, error } = await read()
      if (error) throw new Error(error.message)
      return data as T
    },
  })
}

function useCall<T>(call: (input: T) => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: T) => {
      const { data, error } = await call(input)
      if (error) throw new Error(error.message)
      return data
    },
    onSettled: () => void queryClient.invalidateQueries(),
  })
}

/* notices */
export interface Notice {
  id: string
  title: string
  body: string
  pinned: boolean
  needs_read: boolean
  author: string
  created_at: string
  reads: { user_id: string; read_at: string }[]
}
export const useNotices = () =>
  useExtra<Notice[]>('notices', () =>
    supabase.from('office_notices').select('*, reads:office_notice_reads (user_id, read_at)').order('pinned', { ascending: false }).order('created_at', { ascending: false }),
  )
export const usePostNotice = () =>
  useCall((i: { title: string; body: string; pinned: boolean; needs_read: boolean; author: string }) => supabase.from('office_notices').insert(i))
export const useReadNotice = () =>
  useCall((i: { notice_id: string; user_id: string }) => supabase.from('office_notice_reads').insert(i))
export const useRemoveNotice = () => useCall((id: string) => supabase.from('office_notices').delete().eq('id', id))

/* time off */
export type LeaveKind = 'annual' | 'sick' | 'personal'
export interface LeaveRequest {
  id: string
  user_id: string
  kind: LeaveKind
  starts_on: string
  ends_on: string
  note: string | null
  status: 'pending' | 'approved' | 'declined' | 'cancelled'
  decided_by: string | null
  decision_note: string | null
  created_at: string
}
export const useLeave = () => useExtra<LeaveRequest[]>('leave', () => supabase.from('office_leave_requests').select('*').order('starts_on', { ascending: false }))
export interface WhoIsOff {
  user_id: string
  starts_on: string
  ends_on: string
}
export const useWhoIsOff = () => useExtra<WhoIsOff[]>('off', () => supabase.rpc('office_who_is_off'))
export const useRequestLeave = () =>
  useCall((i: { kind: LeaveKind; from: string; to: string; note: string }) =>
    supabase.rpc('request_leave', { p_kind: i.kind, p_from: i.from, p_to: i.to, p_note: i.note || null }),
  )
export const useDecideLeave = () =>
  useCall((i: { id: string; approve: boolean; note?: string }) => supabase.rpc('decide_leave', { p_id: i.id, p_approve: i.approve, p_note: i.note || null }))
export const useCancelLeave = () => useCall((id: string) => supabase.rpc('cancel_leave', { p_id: id }))

/* rooms */
export interface Room {
  id: string
  name: string
  capacity: number
  purpose: string
}
export interface Booking {
  id: string
  room_id: string
  title: string
  starts_at: string
  ends_at: string
  booked_by: string
}
export interface Occupant {
  user_id: string
  room_id: string
  joined_at: string
}
export const useRooms = () => useExtra<Room[]>('rooms', () => supabase.from('office_rooms').select('*').order('capacity', { ascending: false }))
export const useBookings = (since: string) =>
  useExtra<Booking[]>(`bookings-${since}`, () => supabase.from('office_bookings').select('*').gte('ends_at', since).order('starts_at'))
export const useOccupants = () => useExtra<Occupant[]>('occupants', () => supabase.from('office_room_occupants').select('*'))
export const useBookRoom = () =>
  useCall((i: { room: string; title: string; start: string; end: string }) =>
    supabase.rpc('book_room', { p_room: i.room, p_title: i.title, p_start: i.start, p_end: i.end }),
  )
export const useCancelBooking = () => useCall((id: string) => supabase.rpc('cancel_booking', { p_id: id }))
export const useEnterRoom = () => useCall((room: string | null) => supabase.rpc('enter_room', { p_room: room }))

/* team chat */
export type Channel = 'general' | 'wins' | 'help'
export interface ChannelMessage {
  id: number
  channel: Channel
  sender: string
  body: string
  created_at: string
}
export const useChannel = (channel: Channel) =>
  useExtra<ChannelMessage[]>(`chat-${channel}`, () =>
    supabase.from('office_channel_messages').select('*').eq('channel', channel).order('created_at', { ascending: false }).limit(100),
  )
export const usePostMessage = () =>
  useCall((i: { channel: Channel; body: string; sender: string }) => supabase.from('office_channel_messages').insert(i))

/* insights */
export interface InsightsDay {
  day: string
  due: number
  on_time: number
  late: number
  missed: number
  tasks_approved: number
}
export interface InsightsPerson {
  user_id: string
  full_name: string
  job_title: string | null
  due: number
  filed: number
  on_time: number
  late: number
  missed: number
  tasks_approved: number
  tasks_overdue: number
  avg_stars: number | null
}
export interface Insights {
  from: string
  to: string
  days: number
  totals: { due: number; on_time: number; late: number; missed: number; tasks_approved: number; tasks_overdue: number; avg_stars: number | null }
  open_tasks: number
  waiting_review: number
  pending_leave: number
  by_day: InsightsDay[]
  by_person: InsightsPerson[]
}
export const useInsights = (days: number, enabled: boolean) =>
  useExtra<Insights>(`insights-${days}`, () => supabase.rpc('office_insights', { p_days: days }), enabled)
