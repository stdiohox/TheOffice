// Builds public/demo/office.tar.gz: the empty office database the browser opens.
// Every migration is the real one, in order. Two mechanical changes only:
//   `create extension` is dropped (scripts/demo/stubs.sql stands in for them)
//   now() becomes demo.now(), so the presenter can move the clock
import { PGlite } from '@electric-sql/pglite'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../..')
const MIG = join(root, 'supabase/migrations')
const prep = (sql) =>
  sql
    .replace(/^\s*create\s+extension\b[^;]*;/gim, '-- [demo] create extension dropped')
    .replace(/(?<![\w.])now\(\)/g, 'demo.now()')

const db = new PGlite()
await db.exec(readFileSync(join(root, 'scripts/demo/stubs.sql'), 'utf8'))
for (const f of readdirSync(MIG).sort()) {
  try {
    await db.exec(prep(readFileSync(join(MIG, f), 'utf8')))
  } catch (e) {
    throw new Error(`${f}: ${e.message}`)
  }
}
// Realtime: every change to a public table is queued for src/demo/engine.ts to broadcast.
await db.exec(`
  create table demo.changes (id bigserial primary key, tbl text, op text, new jsonb, old jsonb);
  create function demo.capture() returns trigger language plpgsql security definer set search_path = demo, pg_temp as $$
  begin
    insert into demo.changes (tbl, op, new, old) values (
      tg_table_name, tg_op,
      case when tg_op = 'DELETE' then null else to_jsonb(NEW) end,
      case when tg_op = 'INSERT' then null else to_jsonb(OLD) end);
    return null;
  end $$;
  do $$ declare t text; begin
    for t in select tablename from pg_tables where schemaname = 'public' loop
      execute format('create trigger demo_capture after insert or update or delete on public.%I for each row execute function demo.capture()', t);
    end loop;
  end $$;
`)

const left = await db.query(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and prosrc ~ '(^|[^.a-z_])now\\(\\)'`)
if (left.rows.length) throw new Error(`functions still on the real clock: ${JSON.stringify(left.rows)}`)

if (process.argv.includes('--schema')) {
  const t = await db.query(`select table_name, string_agg(column_name || ' ' || data_type || case when is_nullable='NO' and column_default is null then ' !' else '' end, ', ' order by ordinal_position) cols
    from information_schema.columns where table_schema='public' group by 1 order by 1`)
  for (const r of t.rows) console.log(`${r.table_name}: ${r.cols}`)
  const c = await db.query(`select conrelid::regclass::text t, pg_get_constraintdef(oid) d from pg_constraint where contype='c' and connamespace='public'::regnamespace order by 1`)
  for (const r of c.rows) console.log(`CHECK ${r.t}: ${r.d}`.slice(0, 220))
  const g = await db.query(`select c.relname t, tg.tgname n, p.proname f from pg_trigger tg join pg_class c on c.oid=tg.tgrelid join pg_proc p on p.oid=tg.tgfoid join pg_namespace ns on ns.oid=c.relnamespace where not tg.tgisinternal and ns.nspname='public' order by 1`)
  for (const r of g.rows) console.log(`TRIGGER ${r.t}: ${r.n} -> ${r.f}`)
  const s = await db.query(`select * from public.office_settings`)
  console.log(JSON.stringify(s.rows[0]))
  const j = await db.query(`select jobname, schedule, left(command, 90) c from cron.job`)
  console.log(j.rows)
  process.exit(0)
}
const out = join(root, 'public/demo')
mkdirSync(out, { recursive: true })
const dump = await db.dumpDataDir('gzip')
writeFileSync(join(out, 'office.tar.gz'), Buffer.from(await dump.arrayBuffer()))
console.log(`office.tar.gz: ${(dump.size / 1e6).toFixed(1)} MB`)
