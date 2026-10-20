export class ApiError extends Error {
  constructor(public readonly status: number) {
    super('request_failed');
  }
}

export async function privateApi<T>(
  path: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(
    `/api/${path}`,
    body === undefined
      ? { signal }
      : {
          signal,
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
  );
  if (!response.ok) throw new ApiError(response.status);
  return response.json() as Promise<T>;
}
