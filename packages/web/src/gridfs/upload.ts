// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import type { GridFsFile } from '@mongo-manager/shared/browser'
import { ApiError, csrfTokenNow, failureOf, proofHeaders } from '@/api/client'

/** A content type the server takes (type/subtype of word characters), or none. */
const TYPE = /^[\w.+-]+\/[\w.+-]+$/

/**
 * Phase 4b §1: one file to a bucket as raw bytes with the CSRF header — XMLHttpRequest, because fetch
 * cannot report upload progress. `onProgress` gets 0–100; the returned `abort` stops it. A failure is
 * judged as the API client judges one: a rotated CSRF token is taken and the file sent once more.
 */
export function uploadToBucket(
  href: (contentType?: string) => string,
  file: File,
  onProgress: (percent: number) => void,
): { done: Promise<GridFsFile>; abort: () => void } {
  let current: XMLHttpRequest | null = null
  let stopped = false
  const cancelled = () => new ApiError(0, 'CANCELLED', 'The upload was cancelled')
  const send = (retried: boolean): Promise<GridFsFile> =>
    new Promise<GridFsFile>((resolve, reject) => {
      if (stopped) return reject(cancelled())
      const req = new XMLHttpRequest()
      current = req
      const url = href(TYPE.test(file.type) ? file.type : undefined)
      req.open('PUT', url)
      req.withCredentials = true
      req.setRequestHeader('content-type', 'application/octet-stream')
      const token = csrfTokenNow()
      if (token) req.setRequestHeader('x-csrf-token', token)
      for (const [name, value] of Object.entries(proofHeaders())) req.setRequestHeader(name, value)
      req.upload.onprogress = (e) => {
        if (e.total) onProgress(Math.round((e.loaded / e.total) * 100))
      }
      req.onload = () => {
        if (req.status >= 200 && req.status < 300) {
          onProgress(100)
          try {
            resolve(JSON.parse(req.responseText) as GridFsFile)
          } catch {
            reject(new ApiError(req.status, 'INTERNAL', 'The upload failed'))
          }
          return
        }
        failureOf(req.status, req.responseText, 'gridfs/upload', retried).then((verdict) => {
          if (verdict !== 'retry') return reject(verdict)
          onProgress(0)
          send(true).then(resolve, reject)
        }, reject)
      }
      req.onerror = () => reject(new TypeError('The upload failed'))
      req.onabort = () => reject(cancelled())
      req.send(file)
    })
  return {
    done: send(false),
    abort: () => {
      stopped = true
      current?.abort()
    },
  }
}
