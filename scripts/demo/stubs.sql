create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at timestamptz default now()
);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select jsonb_build_object('sub', auth.uid(), 'role', auth.role()) $$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;

create schema cron;
create table cron.job (
  jobid bigserial primary key, jobname text unique, schedule text, command text, active boolean default true
);
create table cron.job_run_details (
  runid bigserial primary key, jobid bigint, status text, return_message text,
  start_time timestamptz, end_time timestamptz
);
create function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid
$$;
create function cron.unschedule(p_name text) returns boolean language plpgsql as $$
begin
  delete from cron.job where jobname = p_name;
  if not found then raise exception 'could not find valid entry for job ''%''', p_name; end if;
  return true;
end $$;

create schema extensions;
create schema net;
create table net._http_response (id bigserial primary key, status_code int, content text, created timestamptz default now());
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000) returns bigint language sql as
  $$ select 1::bigint $$;

create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
  returns uuid language sql as
  $$ insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $$;
select vault.create_secret('test-cron-secret-0123456789abcdef', 'cron_secret', 'test');
select vault.create_secret('https://office.example.test/api/cron/office-alerts', 'office_alerts_url', 'test');

create schema realtime;
grant usage on schema realtime to anon, authenticated, service_role;
create table realtime.messages (id bigserial primary key, topic text, extension text, payload jsonb, inserted_at timestamptz default now());
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable as
  $$ select nullif(current_setting('realtime.topic', true), '') $$;

create publication supabase_realtime;

-- ---------------------------------------------------------------------------
-- The demo's own schema: the clock every migration reads instead of now(), and
-- what a server would hold (logins, uploaded files, the emails "sent").
-- ---------------------------------------------------------------------------
create schema demo;
grant usage on schema demo to anon, authenticated, service_role;
create table demo.clock (id int primary key default 1 check (id = 1), offset_ms bigint not null default 0);
insert into demo.clock default values;
grant select on demo.clock to anon, authenticated, service_role;
create function demo.now() returns timestamptz language sql stable as
  $$ select pg_catalog.now() + make_interval(secs => (select offset_ms from demo.clock) / 1000.0) $$;
grant execute on function demo.now() to anon, authenticated, service_role;

alter table auth.users add column encrypted_password text;
alter table auth.users add column last_sign_in_at timestamptz;
alter table storage.objects add column updated_at timestamptz default demo.now();

create table demo.tokens (token_hash text primary key, email text not null, type text not null, created_at timestamptz default demo.now());
create table demo.blobs (bucket_id text not null, name text not null, content_type text, bytes bytea not null, primary key (bucket_id, name));
create table demo.outbox (
  id bigserial primary key, sent_at timestamptz not null default demo.now(),
  from_addr text, to_addr text, subject text, html text, body_text text
);
