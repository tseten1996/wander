// A stable per-device identifier, generated and stored alongside the Supabase
// session on first load. The session itself is the credential; this id is
// currently inert — nothing reads it yet. It's reserved for the
// identity-persistence work in epic #97 (e.g. recognizing a returning device
// whose anonymous session Safari has evicted). Kept stable so that future work
// can rely on it.
const KEY = 'wander_device_id'

export function getDeviceId(): string {
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(KEY, id)
  }
  return id
}
