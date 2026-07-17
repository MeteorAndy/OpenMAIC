/**
 * next/server shim for the compiled Bun backend.
 *
 * ponytail: the existing lib/server/api-response.ts returns NextResponse from
 * NextResponse.json(...), and lib/server/resolve-model.ts (etc.) import the
 * NextRequest type. We make NextResponse a plain Web Response subclass so that
 * (a) apiSuccess/apiError keep their EXACT {success,...} envelope, and
 * (b) Hono returns these Response instances unchanged. NextRequest is a type
 * alias for the standard Request — the only Next-specific methods used by the
 * ported handlers (req.json / req.headers.get / req.signal) exist on Request.
 * No real Next.js code is pulled into the binary.
 */
/**
 * NextRequest type. Real Next's NextRequest is a Request plus nextUrl/geo/etc.
 * We extend Request with `nextUrl` so lib helpers that read `req.nextUrl.origin`
 * (buildRequestOrigin in classroom-storage) typecheck without touching lib.
 * ponytail: callers that hand a request to such a helper must route it through
 * src/server/request.ts `withNextUrl` (synthesizes nextUrl); plain Request is
 * still assignable to resolveModelFromHeaders etc. which read only .headers —
 * but to keep one consistent type we mark nextUrl required and adapt at the
 * boundary with withNextUrl.
 */
export interface NextRequest extends Request {
  nextUrl: URL;
}

export class NextResponse<T = unknown> extends Response {
  static json(data: unknown, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return new NextResponse(JSON.stringify(data), { ...init, status: init?.status ?? 200, headers });
  }
  static next(init?: ResponseInit): NextResponse {
    return new NextResponse(null, { status: 200, ...init });
  }
  static redirect(url: string | URL, status: number = 307): NextResponse {
    return new NextResponse(null, {
      status,
      headers: { Location: typeof url === 'string' ? url : url.toString() },
    });
  }
}

export default NextResponse;
