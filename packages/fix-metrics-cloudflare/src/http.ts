// Tiny JSON response helpers shared by the request handlers.

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function jsonError(status: number, code: string, message?: string): Response {
  const body: Record<string, unknown> = { error: { code } };
  if (message !== undefined) body.error = { code, message };
  return json(body, status);
}