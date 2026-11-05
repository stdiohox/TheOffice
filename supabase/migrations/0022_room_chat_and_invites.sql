-- Brightwork office, 0022: talking in a room, and asking people in.
--
-- A room's conversation belongs to whoever is in the room. Step in and you read what
-- has been said; step out and you cannot. Nobody outside can read it, managers
-- included: that is what makes it private. It is deleted when the last person leaves.
--
-- Someone in a room can invite a colleague, who hears in the office and by email
-- (api/office/room-invite). An invite lapses after 30 minutes.

begin;

create table public.office_room_messages (
  id         bigint generated always as identity primary key,
  room_id    text not null references public.office_rooms(id) on delete cascade,
  sender     uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index office_room_messages_room_created on public.office_room_messages (room_id, created_at);

create or replace function public.is_in_room(p_room text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_team_member()
     and exists (select 1 from public.office_room_occupants where user_id = auth.uid() and room_id = p_room)
$$;

alter table public.office_room_messages enable row level security;
create policy "Only people in the room read it" on public.office_room_messages for select to authenticated
  using ((select public.is_in_room(room_id)));
create policy "Only people in the room write in it" on public.office_room_messages for insert to authenticated
  with check (sender = (select auth.uid()) and (select public.is_in_room(room_id)));

-- The last one out: the conversation goes with them.
create or replace function public.office_room_emptied() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' or NEW.room_id is distinct from OLD.room_id then
    if not exists (select 1 from public.office_room_occupants where room_id = OLD.room_id) then
      delete from public.office_room_messages where room_id = OLD.room_id;
      -- Nobody left to join: an invite to an empty room would only confuse.
      update public.office_room_invites set status = 'declined', responded_at = now()
       where room_id = OLD.room_id and status = 'pending';
    end if;
  end if;
  return null;
end $$;
create trigger office_room_emptied after update or delete on public.office_room_occupants
  for each row execute function public.office_room_emptied();

-- Switched off while in a room: out of it.
create or replace function public.office_room_person_off() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if NEW.deactivated_at is not null and OLD.deactivated_at is null then
    delete from public.office_room_occupants where user_id = NEW.id;
  end if;
  return null;
end $$;
create trigger office_room_person_off after update of deactivated_at on public.profiles
  for each row execute function public.office_room_person_off();

create table public.office_room_invites (
  id           uuid primary key default gen_random_uuid(),
  room_id      text not null references public.office_rooms(id) on delete cascade,
  from_user    uuid not null references public.profiles(id) on delete cascade,
  to_user      uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 minutes',
  responded_at timestamptz,
  emailed_at   timestamptz,
  check (from_user <> to_user)
);
create index office_room_invites_to on public.office_room_invites (to_user, status);
alter table public.office_room_invites enable row level security;
create policy "See invites you sent or got" on public.office_room_invites for select to authenticated
  using (to_user = (select auth.uid()) or from_user = (select auth.uid()));

-- Written by the functions below only.
create or replace function public.invite_to_room(p_to uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_room text; v_id uuid;
begin
  select room_id into v_room from public.office_room_occupants where user_id = auth.uid();
  if v_room is null then raise exception 'Step into a room first.' using errcode = '22023'; end if;
  if p_to = auth.uid() then raise exception 'You are already here.' using errcode = '22023'; end if;
  if not exists (select 1 from public.profiles p join public.office_members m on m.user_id = p.id
                  where p.id = p_to and m.active and p.deactivated_at is null) then
    raise exception 'That person is not in the office.' using errcode = '22023';
  end if;
  if exists (select 1 from public.office_absences a where (a.user_id = p_to or a.user_id is null)
              and (now() at time zone 'Africa/Lagos')::date between a.starts_on and a.ends_on) then
    raise exception 'They are away today.' using errcode = '22023';
  end if;
  if exists (select 1 from public.office_room_occupants where user_id = p_to and room_id = v_room) then
    raise exception 'They are already in this room.' using errcode = '22023';
  end if;
  -- Already asked and still waiting: no second email.
  select id into v_id from public.office_room_invites
   where room_id = v_room and from_user = auth.uid() and to_user = p_to and status = 'pending' and expires_at > now();
  if v_id is not null then return v_id; end if;
  insert into public.office_room_invites (room_id, from_user, to_user) values (v_room, auth.uid(), p_to) returning id into v_id;
  return v_id;
end $$;

-- Coming in by any door answers what was waiting for you there.
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
  update public.office_room_invites set status = 'accepted', responded_at = now()
   where to_user = auth.uid() and room_id = p_room and status = 'pending' and expires_at > now();
end $$;

create or replace function public.respond_room_invite(p_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.office_room_invites%rowtype;
begin
  select * into r from public.office_room_invites where id = p_id and to_user = auth.uid() for update;
  if not found then raise exception 'That invite is not yours.' using errcode = '42501'; end if;
  if r.status <> 'pending' or r.expires_at <= now() then raise exception 'That invite has lapsed.' using errcode = '22023'; end if;
  if p_accept then
    perform public.enter_room(r.room_id);
  else
    update public.office_room_invites set status = 'declined', responded_at = now() where id = p_id;
  end if;
end $$;

revoke execute on function public.is_in_room(text) from public, anon;
revoke execute on function public.office_room_emptied() from public, anon, authenticated;
revoke execute on function public.office_room_person_off() from public, anon, authenticated;
revoke execute on function public.invite_to_room(uuid) from public, anon;
revoke execute on function public.respond_room_invite(uuid, boolean) from public, anon;
grant execute on function public.is_in_room(text) to authenticated;
grant execute on function public.invite_to_room(uuid) to authenticated;
grant execute on function public.respond_room_invite(uuid, boolean) to authenticated;

commit;
