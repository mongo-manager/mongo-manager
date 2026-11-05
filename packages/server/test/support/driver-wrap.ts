// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Gokhan OZGEZER
import { MongoServerError } from 'mongodb'

/**
 * As the driver reports a write the server refused as IllegalOperation (20): its own advice, no code
 * of its own, the server's error on originalError (CI 2026-10-23: MongoDB 6.0 deleting one document
 * of a time series).
 */
export function driverWrapped(message = 'refused here', code = 20): MongoServerError {
  const originalError = new MongoServerError({ message, errmsg: message, code })
  const advice =
    'This MongoDB deployment does not support retryable writes. Please add retryWrites=false to your connection string.'
  return new MongoServerError({ message: advice, errmsg: advice, originalError })
}
