import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onUnauthenticated, setCsrfToken } from '../src/api/client'
import { useUpload } from '../src/transfer/useUpload'
import { mockApi } from './support/app'

/**
 * Review 2026-10-13 (web): an import's upload judged a failure by itself — a 401 never signed the
 * page out, and a CSRF token rotated in another tab failed the upload instead of being taken once,
 * unlike every other request (the GridFS upload included).
 */
type Answer = { status: number; body: unknown }
function fakeXhr(answers: Answer[]) {
  const sent: Array<{ headers: Record<string, string> }> = []
  class Fake {
    upload = { onprogress: null as null | ((e: { loaded: number; total: number }) => void) }
    status = 0
    responseText = ''
    withCredentials = false
    onload: null | (() => void) = null
    onerror: null | (() => void) = null
    onabort: null | (() => void) = null
    private headers: Record<string, string> = {}
    open() {}
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v
    }
    send() {
      const answer = answers[sent.length] ?? answers.at(-1)!
      sent.push({ headers: this.headers })
      this.status = answer.status
      this.responseText = JSON.stringify(answer.body)
      queueMicrotask(() => this.onload?.())
    }
    abort() {}
  }
  vi.stubGlobal('XMLHttpRequest', Fake)
  return sent
}

beforeEach(() => setCsrfToken('old-token'))
afterEach(() => {
  vi.unstubAllGlobals()
  onUnauthenticated(() => {})
})

describe('an import upload’s failure', () => {
  it('takes a rotated CSRF token once and sends the file again', async () => {
    mockApi({ 'GET auth/me': () => [200, { csrfToken: 'new-token' }] })
    const sent = fakeXhr([
      { status: 403, body: { code: 'FORBIDDEN', message: 'csrf', details: { reason: 'csrf' } } },
      { status: 200, body: { uploadId: 'u1', size: 3 } },
    ])
    const result = await useUpload().upload('c1', new Blob(['abc']), 'a.csv')
    expect(result).toEqual({ uploadId: 'u1', size: 3 })
    expect(sent.map((s) => s.headers['x-csrf-token'])).toEqual(['old-token', 'new-token'])
  })

  // Review of the web fixes (minor 6): stopped while the new token is fetched, it is not sent again.
  it('stops for good when stopped between the refusal and the retry', async () => {
    let answerMe!: () => void
    const me = new Promise<void>((r) => (answerMe = r))
    mockApi({
      'GET auth/me': async () => {
        await me
        return [200, { csrfToken: 'new-token' }]
      },
    })
    const sent = fakeXhr([
      { status: 403, body: { code: 'FORBIDDEN', message: 'csrf', details: { reason: 'csrf' } } },
      { status: 200, body: { uploadId: 'u1', size: 3 } },
    ])
    const upload = useUpload()
    const done = upload.upload('c1', new Blob(['abc']), 'a.csv')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    upload.abort()
    answerMe()
    await expect(done).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(sent).toHaveLength(1)
    expect(upload.uploading.value).toBe(false)
  })

  it('signs the page out on a 401', async () => {
    const signedOut = vi.fn()
    onUnauthenticated(signedOut)
    fakeXhr([{ status: 401, body: { code: 'UNAUTHENTICATED', message: 'Sign in' } }])
    await expect(useUpload().upload('c1', new Blob(['abc']), 'a.csv')).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    })
    expect(signedOut).toHaveBeenCalledOnce()
  })
})
