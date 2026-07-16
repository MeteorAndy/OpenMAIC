/** Refresh the Supabase session on every matched request (middleware) and return
 * the resolved user so the gate can decide. Single source of auth truth. */
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest): Promise<{
  user: { id: string } | null;
  response: NextResponse;
}> {
  const response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() validates the JWT server-side (no silent session swallow).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { user: user ? { id: user.id } : null, response };
}
