// Local id generator. crypto.randomUUID() throws in non-secure (plain HTTP,
// non-localhost) contexts on this platform, so we avoid it here.
let SEQ = 0
export function uid(prefix = 'e'): string {
  SEQ += 1
  return `${prefix}${Date.now().toString(36)}${SEQ.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}
