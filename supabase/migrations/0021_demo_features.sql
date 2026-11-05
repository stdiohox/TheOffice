-- Brightwork office, 0021: what the demo adds to the office. Written as a real
-- migration so the same rules could ship: notice board, time off, meeting rooms,
-- team chat, and the managers' insights.

begin;

-- ---------------------------------------------------------------------------
-- Notice board. Admins post; everyone reads and says they have read.
-- ---------------------------------------------------------------------------
create table public.office_notices (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(btrim(title)) between 1 and 120),
  body       text not null check (char_length(btrim(body)) between 1 and 4000),
  pinned     boolean not null default false,
  needs_read boolean not null default false,
  author     uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.office_notice_reads (
  notice_id uuid not null references public.office_notices(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  read_at   timestamptz not null default now(),
  primary key (notice_id, user_id)
);
create or replace function public.is_notice_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_office_manager()
      or exists (select 1 from public.profiles where id = auth.uid() and role = 'manager' and deactivated_at is null)
$$;
alter table public.office_notices enable row level security;
alter table public.office_notice_reads enable row level security;
create policy "Team reads notices" on public.office_notices for select to authenticated using ((select public.is_team_member()));
create policy "Admins post notices" on public.office_notices for insert to authenticated
  with check ((select public.is_notice_admin()) and author = (select auth.uid()));
create policy "Admins change notices" on public.office_notices for update to authenticated using ((select public.is_notice_admin()));
create policy "Admins remove notices" on public.office_notices for delete to authenticated using ((select public.is_notice_admin()));
create policy "Team sees who has read" on public.office_notice_reads for select to authenticated using ((select public.is_team_member()));
create policy "You mark your own read" on public.office_notice_reads for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_team_member()));

-- ---------------------------------------------------------------------------
-- Time off. Ask, a manager decides; approval writes a day away, so reports stop
-- being due and the door says so without anyone doing it twice.
-- ---------------------------------------------------------------------------
create table public.office_leave_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  kind          text not null check (kind in ('annual', 'sick', 'personal')),
  starts_on     date not null,
  ends_on       date not null,
  note          text check (char_length(note) <= 300),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  decision_note text check (char_length(decision_note) <= 300),
  absence_id    uuid references public.office_absences(id) on delete set null,
  created_at    timestamptz not null default now(),
  check (ends_on >= starts_on)
);
alter table public.office_leave_requests enable row level security;
create policy "See your own requests; managers see all" on public.office_leave_requests for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_office_manager()));

-- Who is off, for everyone: the dates only. The kind and the note (sick, a visa
-- appointment) stay with the person and whoever decides.
create or replace function public.office_who_is_off()
returns table (user_id uuid, starts_on date, ends_on date)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.user_id, r.starts_on, r.ends_on from public.office_leave_requests r
   where r.status = 'approved' and r.ends_on >= (now() at time zone 'Africa/Lagos')::date
     and public.is_team_member()
   order by r.starts_on
$$;

create or replace function public.request_leave(p_kind text, p_from date, p_to date, p_note text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.is_team_member() then raise exception 'You are not in the office.' using errcode = '42501'; end if;
  if p_to < p_from then raise exception 'The last day is before the first.' using errcode = '22023'; end if;
  if p_from < (now() at time zone 'Africa/Lagos')::date then raise exception 'Choose today or a later day.' using errcode = '22023'; end if;
  if exists (select 1 from public.office_leave_requests where user_id = auth.uid() and status in ('pending', 'approved')
              and daterange(starts_on, ends_on, '[]') && daterange(p_from, p_to, '[]')) then
    raise exception 'You already have a request for those days.' using errcode = '22023';
  end if;
  insert into public.office_leave_requests (user_id, kind, starts_on, ends_on, note)
  values (auth.uid(), p_kind, p_from, p_to, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.decide_leave(p_id uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.office_leave_requests%rowtype; v_absence uuid;
begin
  if not public.is_office_manager() then raise exception 'Only a manager or HR can decide this.' using errcode = '42501'; end if;
  select * into r from public.office_leave_requests where id = p_id for update;
  if not found or r.status <> 'pending' then raise exception 'That request has already been decided.' using errcode = '22023'; end if;
  if r.user_id = auth.uid() then raise exception 'Someone else decides your own request.' using errcode = '42501'; end if;
  if p_approve then
    insert into public.office_absences (user_id, starts_on, ends_on, reason, created_by)
    values (r.user_id, r.starts_on, r.ends_on, initcap(r.kind) || ' leave', auth.uid())
    returning id into v_absence;
  end if;
  update public.office_leave_requests
     set status = case when p_approve then 'approved' else 'declined' end,
         decided_by = auth.uid(), decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''), absence_id = v_absence
   where id = p_id;
end $$;

create or replace function public.cancel_leave(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.office_leave_requests%rowtype;
begin
  select * into r from public.office_leave_requests where id = p_id for update;
  if not found or r.user_id <> auth.uid() then raise exception 'That is not your request.' using errcode = '42501'; end if;
  if r.status not in ('pending', 'approved') then raise exception 'That request is already closed.' using errcode = '22023'; end if;
  if r.absence_id is not null then delete from public.office_absences where id = r.absence_id; end if;
  update public.office_leave_requests set status = 'cancelled', absence_id = null where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Meeting rooms. Book a slot; two bookings of one room never overlap. Step in and
-- the team sees who is in the room.
-- ---------------------------------------------------------------------------
create table public.office_rooms (
  id       text primary key,
  name     text not null,
  capacity int not null,
  purpose  text not null
);
create table public.office_bookings (
  id        uuid primary key default gen_random_uuid(),
  room_id   text not null references public.office_rooms(id),
  title     text not null check (char_length(btrim(title)) between 1 and 120),
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  booked_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create table public.office_room_occupants (
  user_id   uuid primary key references public.profiles(id) on delete cascade,
  room_id   text not null references public.office_rooms(id),
  joined_at timestamptz not null default now()
);
alter table public.office_rooms enable row level security;
alter table public.office_bookings enable row level security;
alter table public.office_room_occupants enable row level security;
create policy "Team sees rooms" on public.office_rooms for select to authenticated using ((select public.is_team_member()));
create policy "Team sees bookings" on public.office_bookings for select to authenticated using ((select public.is_team_member()));
create policy "Team sees who is in a room" on public.office_room_occupants for select to authenticated using ((select public.is_team_member()));

create or replace function public.book_room(p_room text, p_title text, p_start timestamptz, p_end timestamptz)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not public.is_team_member() then raise exception 'You are not in the office.' using errcode = '42501'; end if;
  if p_end <= p_start then raise exception 'The meeting ends before it starts.' using errcode = '22023'; end if;
  if p_end - p_start > interval '4 hours' then raise exception 'Book up to four hours at a time.' using errcode = '22023'; end if;
  if exists (select 1 from public.office_bookings where room_id = p_room and tstzrange(starts_at, ends_at) && tstzrange(p_start, p_end)) then
    raise exception 'That room is taken then. Try another time or room.' using errcode = '23505';
  end if;
  insert into public.office_bookings (room_id, title, starts_at, ends_at, booked_by)
  values (p_room, btrim(p_title), p_start, p_end, auth.uid()) returning id into v_id;
  return v_id;
end $$;

create or replace function public.cancel_booking(p_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.office_bookings where id = p_id and (booked_by = auth.uid() or public.is_notice_admin());
  if not found then raise exception 'Only whoever booked it, or an admin, can cancel this.' using errcode = '42501'; end if;
end $$;

create or replace function public.enter_room(p_room text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.is_team_member() then raise exception 'You are not in the office.' using errcode = '42501'; end if;
  if p_room is null then
    delete from public.office_room_occupants where user_id = auth.uid();
    return;
  end if;
  if (select count(*) from public.office_room_occupants where room_id = p_room and user_id <> auth.uid())
     >= (select capacity from public.office_rooms where id = p_room) then
    raise exception 'That room is full.' using errcode = '22023';
  end if;
  insert into public.office_room_occupants (user_id, room_id) values (auth.uid(), p_room)
  on conflict (user_id) do update set room_id = excluded.room_id, joined_at = now();
end $$;

-- ---------------------------------------------------------------------------
-- Team chat. Open channels everyone in the office reads; knock chats stay private.
-- ---------------------------------------------------------------------------
create table public.office_channel_messages (
  id         bigint generated always as identity primary key,
  channel    text not null check (channel in ('general', 'wins', 'help')),
  sender     uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index office_channel_messages_channel_created on public.office_channel_messages (channel, created_at desc);
alter table public.office_channel_messages enable row level security;
create policy "Team reads the channels" on public.office_channel_messages for select to authenticated using ((select public.is_team_member()));
create policy "Team writes as themselves" on public.office_channel_messages for insert to authenticated
  with check (sender = (select auth.uid()) and (select public.is_team_member()));
create policy "You remove your own" on public.office_channel_messages for delete to authenticated
  using (sender = (select auth.uid()) or (select public.is_notice_admin()));

-- ---------------------------------------------------------------------------
-- Insights: the last N workdays, from what the office already records. For
-- Ngozi and HR, as everything else that compares people. A guide, not a verdict.
-- ---------------------------------------------------------------------------
create or replace function public.office_insights(p_days int default 14)
returns json language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s public.office_settings%rowtype;
  v_today date;
  v_from date;
  v_out json;
begin
  if not public.is_office_manager() then raise exception 'Only a manager or HR can see this.' using errcode = '42501'; end if;
  select * into s from public.office_settings where id = 1;
  v_today := (now() at time zone s.timezone)::date;
  -- The last p_days workdays, today included.
  v_from := (select min(d) from (select d::date from generate_series(v_today - 60, v_today, interval '1 day') d
              where extract(isodow from d)::int = any(s.workdays) order by d desc limit greatest(p_days, 1)) x);

  with people as (
    select p.id, p.full_name, p.job_title from public.profiles p
    join public.office_members m on m.user_id = p.id and m.active
    where p.deactivated_at is null and p.id is distinct from s.manager_id
  ), days as (
    select d::date as day from generate_series(v_from, v_today, interval '1 day') d
    where extract(isodow from d)::int = any(s.workdays)
  ), due as (
    -- Today only counts the reports whose deadline has passed.
    select pe.id as user_id, dd.day, k.kind from people pe cross join days dd
    cross join (values ('signin', s.signin_deadline), ('midday', s.midday_deadline), ('eod', s.eod_deadline)) k(kind, deadline)
    where public.office_expects_report(pe.id, dd.day)
      and (dd.day < v_today or (now() at time zone s.timezone)::time > k.deadline)
  ), filed as (
    select d.user_id, d.day, d.kind, r.timing from due d
    left join public.office_reports r on r.user_id = d.user_id and r.work_date = d.day and r.kind = d.kind
  ), per_person as (
    select pe.id as user_id, pe.full_name, pe.job_title,
      count(f.kind) as due,
      count(f.timing) as filed,
      count(*) filter (where f.timing = 'on_time') as on_time,
      count(*) filter (where f.timing = 'late') as late,
      count(f.kind) - count(f.timing) as missed,
      (select count(*) from public.office_tasks t where t.assigned_to = pe.id and t.status = 'approved' and (t.closed_at at time zone s.timezone)::date >= v_from) as tasks_approved,
      (select count(*) from public.office_tasks t where t.assigned_to = pe.id and t.status in ('open', 'in_progress') and t.due_on < v_today) as tasks_overdue,
      (select round(avg(t.rating), 1) from public.office_tasks t where t.assigned_to = pe.id and t.rating is not null and (t.closed_at at time zone s.timezone)::date >= v_from) as avg_stars
    from people pe left join filed f on f.user_id = pe.id
    group by pe.id, pe.full_name, pe.job_title
  ), per_day as (
    select dd.day,
      count(f.kind) as due,
      count(*) filter (where f.timing = 'on_time') as on_time,
      count(*) filter (where f.timing = 'late') as late,
      count(f.kind) - count(f.timing) as missed,
      (select count(*) from public.office_tasks t where t.status = 'approved' and (t.closed_at at time zone s.timezone)::date = dd.day) as tasks_approved
    from days dd left join filed f on f.day = dd.day group by dd.day
  )
  select json_build_object(
    'from', v_from, 'to', v_today, 'days', (select count(*) from days),
    'totals', (select json_build_object(
        'due', coalesce(sum(due), 0), 'on_time', coalesce(sum(on_time), 0), 'late', coalesce(sum(late), 0), 'missed', coalesce(sum(missed), 0),
        'tasks_approved', coalesce(sum(tasks_approved), 0), 'tasks_overdue', coalesce(sum(tasks_overdue), 0),
        'avg_stars', (select round(avg(t.rating), 1) from public.office_tasks t where t.rating is not null and (t.closed_at at time zone s.timezone)::date >= v_from))
      from per_person),
    'open_tasks', (select count(*) from public.office_tasks where status in ('open', 'in_progress')),
    'waiting_review', (select count(*) from public.office_tasks where status = 'done'),
    'pending_leave', (select count(*) from public.office_leave_requests where status = 'pending'),
    'by_day', (select coalesce(json_agg(per_day order by day), '[]'::json) from per_day),
    'by_person', (select coalesce(json_agg(per_person order by missed desc, late desc, full_name), '[]'::json) from per_person)
  ) into v_out;
  return v_out;
end $$;

revoke execute on function public.is_notice_admin() from public, anon;
revoke execute on function public.office_who_is_off() from public, anon;
revoke execute on function public.request_leave(text, date, date, text) from public, anon;
revoke execute on function public.decide_leave(uuid, boolean, text) from public, anon;
revoke execute on function public.cancel_leave(uuid) from public, anon;
revoke execute on function public.book_room(text, text, timestamptz, timestamptz) from public, anon;
revoke execute on function public.cancel_booking(uuid) from public, anon;
revoke execute on function public.enter_room(text) from public, anon;
revoke execute on function public.office_insights(int) from public, anon;
grant execute on function public.is_notice_admin() to authenticated;
grant execute on function public.office_who_is_off() to authenticated;
grant execute on function public.request_leave(text, date, date, text) to authenticated;
grant execute on function public.decide_leave(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_leave(uuid) to authenticated;
grant execute on function public.book_room(text, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.cancel_booking(uuid) to authenticated;
grant execute on function public.enter_room(text) to authenticated;
grant execute on function public.office_insights(int) to authenticated;

insert into public.office_rooms (id, name, capacity, purpose) values
  ('boardroom', 'Boardroom', 12, 'Team meetings and reviews'),
  ('focus', 'Focus room', 4, 'Small working sessions'),
  ('corner', 'Corner room', 2, 'One-to-ones and quiet chats');

commit;
