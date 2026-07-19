// A stable per-device identifier, kept alongside the Supabase session.
// The session itself is the credential; this id lets us tell the user which
// device a membership belongs to and survive session refreshes gracefully.
const KEY = 'wander_device_id'

export function getDeviceId(): string {
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(KEY, id)
  }
  return id
}
