/**
 * Bridge a Hono context's underlying Request to the NextRequest shape that
 * lib helpers (buildRequestOrigin in classroom-storage, etc.) expect.
 *
 * ponytail: lib reads only `.headers` and `.nextUrl.origin` off the request.
 * `c.req.raw` is a native Request (has .headers, .signal) but no `nextUrl`.
 * Rather than touch lib/*, we synthesize `nextUrl` from the request URL via a
 * Proxy that forwards everything else to the raw Request. Native Request
 * properties are often non-configurable, so a Proxy (not Object.assign) is the
 * safe way to add a field.
 */
import type { NextRequest } from 'next/server';

export function withNextUrl(raw: Request, url: string): NextRequest {
  const nextUrl = new URL(url);
  return new Proxy(raw, {
    get(target, prop) {
      if (prop === 'nextUrl') return nextUrl;
      // ponytail: NO receiver arg — Reflect.get(target, prop) defaults receiver
      // to target, so native Request accessors (headers/signal/...) run their
      // getter with this=real Request and pass the internal-slot brand check.
      // Passing the Proxy as receiver makes .headers throw "can only be used on
      // instances of Request" (broke all 15 withNextUrl routes at model resolve).
      return Reflect.get(target, prop);
    },
  }) as unknown as NextRequest;
}
