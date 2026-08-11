import * as React from 'react'

/**
 * Session-local dismissal for derived reminders (#195).
 *
 * A reminder is ephemeral and never touches the database, so "I've seen this,
 * stop nagging me" can't be a `read_at` column — it's a per-session flag, in
 * the spirit of the #43 activity dots. `sessionStorage` gives us exactly the
 * right lifetime: dismissals survive navigation and remounts within the tab,
 * and evaporate when the session ends, so tomorrow's still-open task nags
 * again. A tiny external store (one Set) lets the two mounted bells — desktop
 * sidebar and mobile top bar — share one dismissal set and re-render together.
 */

const KEY = 'wander:dismissed-reminders'

function load(): Set<string> {
  try {
    const raw = sessionStorage.getItem(KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    // Private-mode / disabled storage: fall back to in-memory only.
    return new Set()
  }
}

let dismissed = load()
const listeners = new Set<() => void>()

function persist(): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify([...dismissed]))
  } catch {
    // Ignore — the in-memory set still holds for this session.
  }
}

/** Hide a reminder for the rest of this browser session. */
export function dismissReminder(id: string): void {
  if (dismissed.has(id)) return
  // New Set reference so useSyncExternalStore sees a changed snapshot.
  dismissed = new Set(dismissed).add(id)
  persist()
  listeners.forEach((notify) => notify())
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

function getSnapshot(): Set<string> {
  return dismissed
}

/** The reactive set of dismissed reminder ids, shared across bell instances. */
export function useDismissedReminders(): Set<string> {
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
