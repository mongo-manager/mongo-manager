// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { ref } from 'vue'
import { ApiError, csrfTokenNow, failureOf, path, proofHeaders } from '@/api/client'

/**
 * Phase 3d-1 spec §4.1, §9: a file goes to the server as raw bytes (application/octet-stream) with
 * the CSRF header. XMLHttpRequest, because fetch cannot report upload progress. A failure is judged
 * as the API client judges one (review 2026-10-13, web): a 401 signs out, a rotated CSRF token is
 * taken and the file sent once more.
 */
export function useUpload() {
  const progress = ref(0)
  const uploading = ref(false)
  let current: XMLHttpRequest | null = null
  let stopped = false

  function upload(
    connectionId: string,
    file: Blob,
    name: string,
  ): Promise<{ uploadId: string; size: number }> {
    progress.value = 0
    uploading.value = true
    stopped = false
    const cancelled = () => new ApiError(0, 'CANCELLED', 'The upload was cancelled')
    const route = path`connections/${connectionId}/transfer/uploads?name=${name}`
    const send = (retried: boolean): Promise<{ uploadId: string; size: number }> =>
      new Promise((resolve, reject) => {
        if (stopped) return reject(cancelled())
        const req = new XMLHttpRequest()
        current = req
        req.open('PUT', new URL(route, new URL('api/', document.baseURI)).href)
        req.withCredentials = true
        req.setRequestHeader('content-type', 'application/octet-stream')
        const token = csrfTokenNow()
        if (token) req.setRequestHeader('x-csrf-token', token)
        for (const [name, value] of Object.entries(proofHeaders())) req.setRequestHeader(name, value)
        req.upload.onprogress = (e) => {
          if (e.total) progress.value = Math.round((e.loaded / e.total) * 100)
        }
        req.onload = () => {
          if (req.status >= 200 && req.status < 300) {
            let body: { uploadId?: string; size?: number } = {}
            try {
              body = JSON.parse(req.responseText)
            } catch {
              // An answer that is not JSON: the upload is not known.
            }
            if (!body.uploadId) return reject(new ApiError(req.status, 'INTERNAL', 'The upload failed'))
            progress.value = 100
            return resolve({ uploadId: body.uploadId, size: body.size ?? 0 })
          }
          failureOf(req.status, req.responseText, route, retried).then((verdict) => {
            if (verdict !== 'retry') return reject(verdict)
            progress.value = 0
            send(true).then(resolve, reject)
          }, reject)
        }
        req.onerror = () => reject(new TypeError('The upload failed'))
        req.onabort = () => reject(cancelled())
        req.send(file)
      })
    return send(false).finally(() => {
      uploading.value = false
      current = null
    })
  }

  return {
    progress,
    uploading,
    upload,
    abort: () => {
      stopped = true
      current?.abort()
    },
  }
}
