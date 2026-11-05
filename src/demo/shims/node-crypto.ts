/** The bits of node:crypto the routes use. Dedup keys and a local secret check: nothing here protects anything. */
function fnvHex(s: string): string {
  let out = ''
  for (let seed = 0; seed < 8; seed++) {
    let h = 0x811c9dc5 ^ seed
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    out += (h >>> 0).toString(16).padStart(8, '0')
  }
  return out
}

export function createHash(_algo: string) {
  let data = ''
  const api = {
    update(s: string) {
      data += s
      return api
    },
    digest(enc?: string) {
      const hex = fnvHex(data)
      return enc === 'hex' ? hex : hex
    },
  }
  return api
}

export const timingSafeEqual = (a: string, b: string) => a === b

export function randomBytes(n: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  return { toString: () => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') }
}
