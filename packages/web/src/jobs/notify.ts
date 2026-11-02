const ASKED = 'mm.notify.asked'

/** U8: a system notification when the tab is hidden; permission is asked once, never at load. */
export function notifyWhenHidden(title: string, body: string): void {
  if (typeof Notification === 'undefined' || !document.hidden || Notification.permission !== 'granted') return
  try {
    new Notification(title, { body, tag: 'mongo-manager-job' })
  } catch {
    // Some browsers allow notifications only from a service worker; the toast stays.
  }
}

export function shouldAskNotifications(): boolean {
  try {
    return (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'default' &&
      localStorage.getItem(ASKED) !== '1'
    )
  } catch {
    return false
  }
}

/** Remembers the answer (or "not now") so the question comes once. */
export function rememberAsked(): void {
  try {
    localStorage.setItem(ASKED, '1')
  } catch {
    // Private mode: we may ask again next time.
  }
}

export async function askNotifications(): Promise<void> {
  rememberAsked()
  if (typeof Notification !== 'undefined') await Notification.requestPermission()
}
