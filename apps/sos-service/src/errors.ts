// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Small HTTP error helper shared by the SOS domain modules.
 *
 * A thrown `HttpError` is rendered by the Express error handler with the given
 * status and a stable machine-readable `error` code. Domain modules never
 * return a successful empty/zero result for a capability they cannot execute.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message || code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code: string, message?: string, details?: unknown): HttpError {
  return new HttpError(400, code, message, details);
}

export function notFoundError(code = 'not_found', message?: string): HttpError {
  return new HttpError(404, code, message);
}

export function conflict(code: string, message?: string, details?: unknown): HttpError {
  return new HttpError(409, code, message, details);
}

export function forbidden(code = 'forbidden', message?: string, details?: unknown): HttpError {
  return new HttpError(403, code, message, details);
}

export function badGateway(code = 'upstream_invalid_response', message?: string, details?: unknown): HttpError {
  return new HttpError(502, code, message, details);
}

export function serviceUnavailable(code = 'capability_unavailable', message?: string, details?: unknown): HttpError {
  return new HttpError(503, code, message, details);
}
