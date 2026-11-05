import { asOwner, asRole, ident, lit, type Who } from './engine'

/**
 * PostgREST, as far as the office asks of it: the URL becomes SQL and runs as the
 * caller. JSON comes from Postgres itself (json_agg), so timestamps and arrays have
 * the shape the real API gives them.
 */

interface PgError {
  message: string
  code?: string
  detail?: string
  hint?: string
}

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export const errorResponse = (e: unknown) => {
  const err = e as PgError
  const status = err.code === '42501' ? 403 : err.code === '23505' ? 409 : 400
  return json(status, { message: err.message, code: err.code ?? 'P0001', details: err.detail ?? null, hint: err.hint ?? null })
}

/* ---------------------------------------------------------------- filters */

/** Split on commas outside parentheses, braces and double quotes. */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let cur = ''
  for (const c of s) {
    if (c === '"') quoted = !quoted
    if (!quoted && (c === '(' || c === '{')) depth++
    if (!quoted && (c === ')' || c === '}')) depth--
    if (c === ',' && depth === 0 && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur) out.push(cur)
  return out
}

const unquote = (v: string) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\"/g, '"') : v)

const OPS: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike', cs: '@>', cd: '<@' }

function condition(column: string, raw: string): string {
  const col = `t0.${ident(column)}`
  let v = raw
  let negate = false
  if (v.startsWith('not.')) {
    negate = true
    v = v.slice(4)
  }
  const dot = v.indexOf('.')
  const op = v.slice(0, dot)
  const value = v.slice(dot + 1)
  let sql: string
  if (op === 'is') {
    if (!['null', 'true', 'false'].includes(value)) throw new Error(`is.${value}`)
    sql = `${col} is ${value}`
  } else if (op === 'in') {
    const items = splitTop(value.slice(1, -1)).map((x) => lit(unquote(x)))
    sql = items.length ? `${col} in (${items.join(', ')})` : 'false'
  } else if (OPS[op]) {
    sql = `${col} ${OPS[op]} ${lit(unquote(value))}`
  } else {
    throw new Error(`Unsupported filter: ${column}=${raw}`)
  }
  return negate ? `not (${sql})` : sql
}

function whereClause(params: URLSearchParams): string {
  const parts: string[] = []
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(key)) continue
    if (key === 'or') {
      const alts = splitTop(raw.slice(1, -1)).map((alt) => {
        const dot = alt.indexOf('.')
        return condition(alt.slice(0, dot), alt.slice(dot + 1))
      })
      parts.push(`(${alts.join(' or ')})`)
    } else parts.push(condition(key, raw))
  }
  return parts.length ? ` where ${parts.join(' and ')}` : ''
}

function orderClause(params: URLSearchParams): string {
  const o = params.get('order')
  if (!o) return ''
  const terms = o.split(',').map((part) => {
    const [col, dir, nulls] = part.split('.')
    return `t0.${ident(col)}${dir === 'desc' ? ' desc' : ''}${nulls === 'nullslast' ? ' nulls last' : nulls === 'nullsfirst' ? ' nulls first' : ''}`
  })
  return ` order by ${terms.join(', ')}`
}

function pageClause(params: URLSearchParams): string {
  const limit = params.get('limit')
  const offset = params.get('offset')
  return `${limit ? ` limit ${Number(limit)}` : ''}${offset ? ` offset ${Number(offset)}` : ''}`
}

/* ---------------------------------------------------------------- select */

interface ForeignKey {
  name: string
  from: string
  to: string
  fromCols: string[]
  toCols: string[]
}

let foreignKeys: Promise<ForeignKey[]> | null = null

function loadForeignKeys() {
  foreignKeys ??= asOwner(async (db) => {
    const r = await db.query<{ name: string; from: string; to: string; from_cols: string[]; to_cols: string[] }>(`
      select c.conname as name, f.relname as "from", t.relname as "to",
        (select array_agg(a.attname order by k.ord) from unnest(c.conkey) with ordinality k(n, ord)
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n) as from_cols,
        (select array_agg(a.attname order by k.ord) from unnest(c.confkey) with ordinality k(n, ord)
           join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n) as to_cols
      from pg_constraint c
      join pg_class f on f.oid = c.conrelid join pg_class t on t.oid = c.confrelid
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace`)
    return r.rows.map((x) => ({ name: x.name, from: x.from, to: x.to, fromCols: x.from_cols, toCols: x.to_cols }))
  })
  return foreignKeys
}

async function selectList(select: string, table: string, alias: string, depth = 0): Promise<string> {
  const items = splitTop(select.replace(/\s+/g, '') || '*')
  const parts: string[] = []
  for (const item of items) {
    if (item === '*') {
      parts.push(`${alias}.*`)
      continue
    }
    const embed = item.match(/^(?:([a-z_0-9]+):)?([a-z_0-9]+)(?:!([a-z_0-9]+))?\((.*)\)$/)
    if (!embed) {
      const m = item.match(/^(?:([a-z_0-9]+):)?([a-z_0-9]+)$/)
      if (!m) throw new Error(`Unsupported select: ${item}`)
      parts.push(`${alias}.${ident(m[2])} as ${ident(m[1] ?? m[2])}`)
      continue
    }
    const [, as, target, hint, inner] = embed
    const inner_alias = `e${depth}_${parts.length}`
    const fks = await loadForeignKeys()
    const toOne = fks.find((f) => f.from === table && f.to === target && (!hint || f.name === hint))
    const toMany = fks.find((f) => f.from === target && f.to === table && (!hint || f.name === hint))
    const fk = toOne ?? toMany
    if (!fk) throw Object.assign(new Error(`No relationship between ${table} and ${target}`), { code: 'PGRST200' })
    const on = toOne
      ? fk.fromCols.map((c, i) => `${inner_alias}.${ident(fk.toCols[i])} = ${alias}.${ident(c)}`)
      : fk.fromCols.map((c, i) => `${inner_alias}.${ident(c)} = ${alias}.${ident(fk.toCols[i])}`)
    const list = await selectList(inner, target, inner_alias, depth + 1)
    const sub = `select ${list} from public.${ident(target)} ${inner_alias} where ${on.join(' and ')}`
    parts.push(
      toOne
        ? `(select to_json(x) from (${sub} limit 1) x) as ${ident(as ?? target)}`
        : `coalesce((select json_agg(x) from (${sub}) x), '[]'::json) as ${ident(as ?? target)}`,
    )
  }
  return parts.join(', ')
}

/* ---------------------------------------------------------------- tables */

function shape(rows: unknown[], headers: Headers, status: number) {
  if ((headers.get('accept') ?? '').includes('vnd.pgrst.object')) {
    if (rows.length !== 1) {
      return json(406, {
        code: 'PGRST116',
        message: 'JSON object requested, multiple (or no) rows returned',
        details: `The result contains ${rows.length} rows`,
        hint: null,
      })
    }
    return json(status, rows[0])
  }
  return json(status, rows)
}

async function tableRequest(who: Who, table: string, url: URL, method: string, headers: Headers, body: string | null): Promise<Response> {
  const params = url.searchParams
  const prefer = headers.get('prefer') ?? ''
  const wantRows = prefer.includes('return=representation')
  const name = `public.${ident(table)}`
  const list = await selectList(params.get('select') ?? '*', table, 't0')
  const where = whereClause(params)
  const returning = (statement: string) =>
    `with w as (${statement} returning *) select coalesce(json_agg(r), '[]'::json) as j from (select ${list} from w t0) r`

  if (method === 'GET' || method === 'HEAD') {
    const sql = `select coalesce(json_agg(r), '[]'::json) as j from (select ${list} from ${name} t0${where}${orderClause(params)}${pageClause(params)}) r`
    const rows = await asRole(who, async (tx) => (await tx.query<{ j: unknown[] }>(sql)).rows[0].j)
    return shape(rows, headers, 200)
  }

  if (method === 'POST') {
    const given = JSON.parse(body ?? '[]') as Record<string, unknown> | Record<string, unknown>[]
    const rows = Array.isArray(given) ? given : [given]
    const columns = params.get('columns')?.split(',').map((c) => c.replace(/"/g, '')) ?? Object.keys(rows[0] ?? {})
    const cols = columns.map(ident).join(', ')
    let conflict = ''
    if (prefer.includes('resolution=merge-duplicates') || prefer.includes('resolution=ignore-duplicates')) {
      const target = params.get('on_conflict')
      const on = target ? `(${target.split(',').map(ident).join(', ')})` : ''
      conflict = prefer.includes('ignore-duplicates')
        ? ` on conflict ${on} do nothing`
        : ` on conflict ${on} do update set ${columns.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`
    }
    const insert = `insert into ${name} as t0 (${cols}) select ${cols} from jsonb_populate_recordset(null::${name}, ${lit(JSON.stringify(rows))}::jsonb)${conflict}`
    if (!wantRows) {
      await asRole(who, (tx) => tx.query(insert))
      return new Response(null, { status: 201 })
    }
    const out = await asRole(who, async (tx) => (await tx.query<{ j: unknown[] }>(returning(insert))).rows[0].j)
    return shape(out, headers, 201)
  }

  if (method === 'PATCH') {
    const patch = JSON.parse(body ?? '{}') as Record<string, unknown>
    const cols = Object.keys(patch).map(ident)
    if (!cols.length) return new Response(null, { status: 204 })
    const row = `jsonb_populate_record(null::${name}, ${lit(JSON.stringify(patch))}::jsonb)`
    const statement = `update ${name} t0 set (${cols.join(', ')}) = (select ${cols.join(', ')} from ${row})${where}`
    if (!wantRows) {
      await asRole(who, (tx) => tx.query(statement))
      return new Response(null, { status: 204 })
    }
    const out = await asRole(who, async (tx) => (await tx.query<{ j: unknown[] }>(returning(statement))).rows[0].j)
    return shape(out, headers, 200)
  }

  if (method === 'DELETE') {
    const statement = `delete from ${name} t0${where}`
    if (!wantRows) {
      await asRole(who, (tx) => tx.query(statement))
      return new Response(null, { status: 204 })
    }
    const out = await asRole(who, async (tx) => (await tx.query<{ j: unknown[] }>(returning(statement))).rows[0].j)
    return shape(out, headers, 200)
  }

  return json(405, { message: method })
}

/* ---------------------------------------------------------------- rpc */

interface Fn {
  name: string
  retset: boolean
  rettype: string
  args: { name: string; type: string }[]
}

let functions: Promise<Fn[]> | null = null

function loadFunctions() {
  functions ??= asOwner(async (db) => {
    const r = await db.query<{ name: string; retset: boolean; rettype: string; names: string[] | null; types: string[] | null; nargs: number }>(`
      select p.proname as name, p.proretset as retset, format_type(p.prorettype, null) as rettype,
        p.proargnames as names, p.pronargs as nargs,
        (select array_agg(format_type(t, null) order by ord) from unnest(p.proargtypes::oid[]) with ordinality u(t, ord)) as types
      from pg_proc p where p.pronamespace = 'public'::regnamespace`)
    return r.rows.map((f) => ({
      name: f.name,
      retset: f.retset,
      rettype: f.rettype,
      args: (f.types ?? []).map((type, i) => ({ type, name: f.names?.[i] ?? '' })),
    }))
  })
  return functions
}

function argValue(v: unknown, type: string): string {
  if (v === null || v === undefined) return `null::${type}`
  if (type.endsWith('[]')) {
    const items = (v as unknown[]).map((x) => (x === null ? 'NULL' : `"${String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`))
    return `${lit(`{${items.join(',')}}`)}::${type}`
  }
  if (typeof v === 'object') return `${lit(JSON.stringify(v))}::${type}`
  return `${lit(String(v))}::${type}`
}

export async function callRpc(who: Who, name: string, args: Record<string, unknown>): Promise<unknown> {
  const given = Object.keys(args)
  const fn = (await loadFunctions()).find((f) => f.name === name && given.every((g) => f.args.some((a) => a.name === g)))
  if (!fn) throw Object.assign(new Error(`Could not find the function public.${name}`), { code: 'PGRST202' })
  const list = given.map((g) => `${ident(g)} => ${argValue(args[g], fn.args.find((a) => a.name === g)!.type)}`).join(', ')
  const call = `public.${ident(name)}(${list})`
  return asRole(who, async (tx) => {
    if (fn.retset) return (await tx.query<{ j: unknown }>(`select coalesce(json_agg(r), '[]'::json) as j from ${call} r`)).rows[0].j
    if (fn.rettype === 'void') {
      await tx.query(`select ${call}`)
      return null
    }
    if (fn.rettype === 'record') return (await tx.query<{ j: unknown }>(`select to_json(r) as j from ${call} r`)).rows[0].j
    return (await tx.query<{ j: unknown }>(`select to_json(${call}) as j`)).rows[0].j
  })
}

/* ---------------------------------------------------------------- entry */

export async function restRequest(who: Who, url: URL, method: string, headers: Headers, body: string | null): Promise<Response> {
  const path = url.pathname.split('/rest/v1/')[1]
  try {
    if (path.startsWith('rpc/')) {
      const out = await callRpc(who, path.slice(4), body ? (JSON.parse(body) as Record<string, unknown>) : {})
      return out === null ? new Response(null, { status: 204 }) : json(200, out)
    }
    return await tableRequest(who, path, url, method, headers, body)
  } catch (e) {
    return errorResponse(e)
  }
}
