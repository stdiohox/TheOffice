-- Brightwork office, 0023: a code on the door of every room in use.
--
-- The first person into an empty room gets a new six-digit code. Anyone else needs
-- that code, or an invite from someone inside. Nobody is exempt, managers included:
-- a room's conversation is private to whoever is in it (0022). The code is readable
-- only from inside, and goes when the last person leaves. Five wrong tries at a room
-- stop that person trying it for 10 minutes.

begin;

create table public.office_room_codes (
  room_id    text primary key references public.office_rooms(id) on delete cascade,
  code       text not null check (code ~ '^[0-9]{6}$'),
  created_at timestamptz not null default now()
);
alter table public.office_room_codes enable row level security;
create policy "Only people in the room see its code" on public.office_room_codes for select to authenticated
  using ((select public.is_in_room(room_id)));

-- No policy: written and read by enter_room only. Kept 10 minutes.
create table public.office_room_code_tries (
  user_id uuid not null references public.profiles(id) on delete cascade,
  room_id text not null references public.office_rooms(id) on delete cascade,
  at      timestamptz not null default now()
);
create index office_room_code_tries_who on public.office_room_code_tries (user_id, room_id, at);
alter table public.office_room_code_tries enable row level security;

-- Going in, once it is settled that you may. Not callable from outside.
create or replace function public.office_room_place(p_room text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- One person at a time through a door: two at once could both count an empty room,
  -- or come in as the last person leaves and lose the code under them.
  perform 1 from public.office_rooms
   where id = p_room or id = (select room_id from public.office_room_occupants where user_id = auth.uid())
   order by id for update;
  if (select count(*) from public.office_room_occupants where room_id = p_room and user_id <> auth.uid())
     >= (select capacity from public.office_rooms where id = p_room) then
    raise exception 'That room is full.' using errcode = '22023';
  end if;
  -- Nobody else here: a new code for a new conversation.
  if not exists (select 1 from public.office_room_occupants where room_id = p_room and user_id <> auth.uid()) then
    insert into public.office_room_codes (room_id, code)
    -- random() is enough for sample data. A real rollout uses gen_random_bytes.
    values (p_room, lpad(floor(random() * 1000000)::int::text, 6, '0'))
    on conflict (room_id) do update set code = excluded.code, created_at = now();
  end if;
  insert into public.office_room_occupants (user_id, room_id) values (auth.uid(), p_room)
  on conflict (user_id) do update set room_id = excluded.room_id, joined_at = now();
  update public.office_room_invites set status = 'accepted', responded_at = now()
   where to_user = auth.uid() and room_id = p_room and status = 'pending' and expires_at > now();
end $$;

-- The answer comes back as a word, not an exception: an exception would undo the
-- record of a wrong try, and the limit would count nothing.
--   in  out  needs_code  wrong_code  locked
drop function public.enter_room(text);
create function public.enter_room(p_room text, p_code text default null)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_code text;
  v_tries int;
begin
  if not public.is_team_member() then raise exception 'You are not in the office.' using errcode = '42501'; end if;
  if p_room is null then
    perform 1 from public.office_rooms where id = (select room_id from public.office_room_occupants where user_id = auth.uid()) for update;
    delete from public.office_room_occupants where user_id = auth.uid();
    return 'out';
  end if;
  if exists (select 1 from public.office_room_occupants where user_id = auth.uid() and room_id = p_room) then
    return 'in';
  end if;
  -- In use: the code, or an invite still waiting.
  if exists (select 1 from public.office_room_occupants where room_id = p_room)
     and not exists (select 1 from public.office_room_invites where to_user = auth.uid() and room_id = p_room and status = 'pending' and expires_at > now()) then
    delete from public.office_room_code_tries where at < now() - interval '10 minutes';
    select count(*) into v_tries from public.office_room_code_tries where user_id = auth.uid() and room_id = p_room;
    if v_tries >= 5 then return 'locked'; end if;
    if nullif(btrim(coalesce(p_code, '')), '') is null then return 'needs_code'; end if;
    select code into v_code from public.office_room_codes where room_id = p_room;
    if v_code is distinct from btrim(p_code) then
      insert into public.office_room_code_tries (user_id, room_id) values (auth.uid(), p_room);
      return case when v_tries + 1 >= 5 then 'locked' else 'wrong_code' end;
    end if;
    delete from public.office_room_code_tries where user_id = auth.uid() and room_id = p_room;
  end if;
  perform public.office_room_place(p_room);
  return 'in';
end $$;

-- An invite is the pass: joining from one takes no code.
create or replace function public.respond_room_invite(p_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.office_room_invites%rowtype;
begin
  if not public.is_team_member() then raise exception 'You are not in the office.' using errcode = '42501'; end if;
  select * into r from public.office_room_invites where id = p_id and to_user = auth.uid() for update;
  if not found then raise exception 'That invite is not yours.' using errcode = '42501'; end if;
  if r.status <> 'pending' or r.expires_at <= now() then raise exception 'That invite has lapsed.' using errcode = '22023'; end if;
  if p_accept then
    perform public.office_room_place(r.room_id);
  else
    update public.office_room_invites set status = 'declined', responded_at = now() where id = p_id;
  end if;
end $$;

-- The last one out takes the code too.
create or replace function public.office_room_emptied() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' or NEW.room_id is distinct from OLD.room_id then
    if not exists (select 1 from public.office_room_occupants where room_id = OLD.room_id) then
      delete from public.office_room_messages where room_id = OLD.room_id;
      delete from public.office_room_codes where room_id = OLD.room_id;
      update public.office_room_invites set status = 'declined', responded_at = now()
       where room_id = OLD.room_id and status = 'pending';
    end if;
  end if;
  return null;
end $$;

revoke execute on function public.office_room_place(text) from public, anon, authenticated;
revoke execute on function public.enter_room(text, text) from public, anon;
grant execute on function public.enter_room(text, text) to authenticated;

commit;
