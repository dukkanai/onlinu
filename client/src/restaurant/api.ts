import { getApiKey } from '../lib/auth';

export class RestaurantAPIError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}

async function request<T>(prefix: string, path: string, options: RequestInit = {}, admin = false): Promise<T> {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('..')) throw new RestaurantAPIError('invalid_request', 400);
  const headers = new Headers(options.headers);
  // The public transport must never inherit the dashboard's master credential.
  headers.delete('X-API-Key');
  if (admin) headers.set('X-API-Key', getApiKey());
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(prefix + path, { ...options, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new RestaurantAPIError(typeof body.error === 'string' ? body.error : 'server_error', response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const storefront = <T,>(path: string, options?: RequestInit) => request<T>('/storefront-api', path, options);
export const adminRestaurant = <T,>(path: string, options?: RequestInit) => request<T>('/api/restaurant', path, options, true);
