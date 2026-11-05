import { asOwner, asRole, type Who } from './engine'

/**
 * Supabase Storage, as far as the office asks of it. A row in storage.objects goes
 * through the migrations' own policies as the caller; the bytes sit beside it.
 * Signed links are blob: URLs, and only come back for rows the caller may read.
 */
type Result<T> = Promise<{ data: T | null; error: { message: string } | null }>

const urls = new Map<string, string>()

async function linkFor(who: Who, bucket: string, path: string): Promise<string | null> {
  const key = `${bucket}/${path}`
  const can = await asRole(who, async (tx) => (await tx.query(`select 1 from storage.objects where bucket_id = $1 and name = $2`, [bucket, path])).rows.length > 0)
  if (!can) return null
  const have = urls.get(key)
  if (have) return have
  const blob = await asOwner(async (tx) => (await tx.query<{ bytes: Uint8Array; content_type: string }>(`select bytes, content_type from demo.blobs where bucket_id = $1 and name = $2`, [bucket, path])).rows[0])
  if (!blob) return null
  const url = URL.createObjectURL(new Blob([blob.bytes as BlobPart], { type: blob.content_type }))
  urls.set(key, url)
  return url
}

export function demoStorage(getWho: () => Promise<Who>) {
  return {
    from(bucket: string) {
      return {
        async upload(path: string, file: Blob, opts?: { contentType?: string; upsert?: boolean }): Result<{ path: string }> {
          const who = await getWho()
          const type = opts?.contentType ?? file.type
          try {
            const rule = await asOwner(async (tx) => (await tx.query<{ file_size_limit: number | null; allowed_mime_types: string[] | null }>(`select file_size_limit, allowed_mime_types from storage.buckets where id = $1`, [bucket])).rows[0])
            if (!rule) return { data: null, error: { message: 'Bucket not found' } }
            if (rule.file_size_limit && file.size > Number(rule.file_size_limit)) return { data: null, error: { message: 'The object exceeded the maximum allowed size' } }
            if (rule.allowed_mime_types && !rule.allowed_mime_types.includes(type)) return { data: null, error: { message: `mime type ${type} is not supported` } }
            const bytes = new Uint8Array(await file.arrayBuffer())
            await asRole(who, (tx) =>
              tx.query(`insert into storage.objects (bucket_id, name, owner, metadata) values ($1, $2, $3, $4)`, [
                bucket,
                path,
                who.sub ?? null,
                JSON.stringify({ size: file.size, mimetype: type }),
              ]),
            )
            await asOwner((tx) => tx.query(`insert into demo.blobs (bucket_id, name, content_type, bytes) values ($1, $2, $3, $4)`, [bucket, path, type, bytes]))
            return { data: { path }, error: null }
          } catch (e) {
            return { data: null, error: { message: (e as Error).message } }
          }
        },

        async list(prefix: string, opts?: { limit?: number }): Result<{ name: string }[]> {
          const who = await getWho()
          const rows = await asRole(who, async (tx) => (await tx.query<{ name: string }>(`select name from storage.objects where bucket_id = $1 and name like $2 limit $3`, [bucket, `${prefix}/%`, opts?.limit ?? 100])).rows)
          return { data: rows.map((r) => ({ name: r.name.slice(prefix.length + 1) })), error: null }
        },

        async remove(paths: string[]): Result<{ name: string }[]> {
          const who = await getWho()
          try {
            const gone = await asRole(who, async (tx) => (await tx.query<{ name: string }>(`delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning name`, [bucket, paths])).rows)
            await asOwner((tx) => tx.query(`delete from demo.blobs where bucket_id = $1 and name = any($2::text[])`, [bucket, gone.map((g) => g.name)]))
            return { data: gone, error: null }
          } catch (e) {
            return { data: null, error: { message: (e as Error).message } }
          }
        },

        async createSignedUrl(path: string, _seconds: number): Result<{ signedUrl: string }> {
          const url = await linkFor(await getWho(), bucket, path)
          return url ? { data: { signedUrl: url }, error: null } : { data: null, error: { message: 'Object not found' } }
        },

        async createSignedUrls(paths: string[], _seconds: number): Result<{ path: string; signedUrl: string; error: string | null }[]> {
          const who = await getWho()
          const out = []
          for (const path of paths) {
            const url = await linkFor(who, bucket, path)
            out.push({ path, signedUrl: url ?? '', error: url ? null : 'Object not found' })
          }
          return { data: out, error: null }
        },
      }
    },
  }
}
