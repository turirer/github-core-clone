// Shared HTTP request/response shapes for the forge's handlers.

export interface HttpRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  authed: boolean;
}

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

export function jsonResult(status: number, body: unknown, headers: Record<string, string> = {}): HttpResult {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
    headers,
  };
}

export function emptyResult(status: number, headers: Record<string, string> = {}): HttpResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0), headers };
}

export function notFound(message = 'Not Found'): HttpResult {
  return jsonResult(404, { message });
}

export function unauthorized(message = 'Requires authentication'): HttpResult {
  return jsonResult(401, { message });
}

/** Parse a JSON request body. Returns {ok:false} when the body is present but malformed. */
export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
