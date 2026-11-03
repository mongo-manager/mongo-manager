import type { Locator, Page } from '@playwright/test'

/**
 * README and Product Hunt media (2026-10-31): a recorded page shows no pointer. This draws one that
 * follows the mouse, with a ring where it presses; and moves the mouse there in steps, as a hand
 * would, rather than jumping. As text: this package is typed without the DOM.
 */
export const CURSOR_SCRIPT = `(() => {
  const draw = () => {
    if (document.getElementById('mm-media-cursor')) return
    const style = document.createElement('style')
    style.textContent = [
      '#mm-media-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;',
      'transform:translate(-100px,-100px);transition:transform 16ms linear}',
      '#mm-media-cursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}',
      '.mm-media-ring{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;',
      'border:2px solid rgba(16,185,129,.9);z-index:2147483646;pointer-events:none;animation:mm-ring .45s ease-out forwards}',
      '@keyframes mm-ring{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}',
    ].join('')
    document.head.appendChild(style)
    const cursor = document.createElement('div')
    cursor.id = 'mm-media-cursor'
    cursor.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    document.body.appendChild(cursor)
    document.addEventListener('mousemove', (e) => {
      cursor.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'
    }, true)
    document.addEventListener('mousedown', (e) => {
      const ring = document.createElement('div')
      ring.className = 'mm-media-ring'
      ring.style.left = e.clientX + 'px'
      ring.style.top = e.clientY + 'px'
      document.body.appendChild(ring)
      setTimeout(() => ring.remove(), 500)
    }, true)
  }
  if (document.body) draw()
  else document.addEventListener('DOMContentLoaded', draw)
})()`

let at = { x: 720, y: 450 }

/** Moves the pointer to the middle of `target` in small steps, then rests a moment. */
export async function glide(page: Page, target: Locator, steps = 22): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error('nothing to move to')
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    await page.mouse.move(at.x + (to.x - at.x) * ease, at.y + (to.y - at.y) * ease)
    await page.waitForTimeout(12)
  }
  at = to
  await page.waitForTimeout(120)
}

/**
 * Moves there, then clicks, as a person would. The click finds the target where it is now: a page
 * still drawing (an answer streaming in) may have moved it while the pointer travelled.
 */
export async function press(page: Page, target: Locator): Promise<void> {
  await glide(page, target)
  await target.click({ delay: 70 })
  // A target the click took away (a list's option) is not waited for.
  const box = await target.boundingBox({ timeout: 300 }).catch(() => null)
  if (box) at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
