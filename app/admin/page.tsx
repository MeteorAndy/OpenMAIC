import { getCurrentSession } from '@/lib/server/session';
import { isAdmin } from '@/lib/server/admin';
import { AdminConsole } from './admin-console';

// Session check must run per-request, never at build time.
export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  // A broken auth/DB environment should surface as 403, not a 500 — this page
  // exists for debugging operations.
  let session: Awaited<ReturnType<typeof getCurrentSession>> = null;
  try {
    session = await getCurrentSession();
  } catch {
    session = null;
  }

  if (!session || !isAdmin(session.user.id)) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
        <div className="w-full max-w-sm space-y-2 rounded-xl border bg-card p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold">403</h1>
          <p className="text-sm text-muted-foreground">无权限访问该页面</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background px-4 py-16">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">运营后台</h1>
          <p className="text-sm text-muted-foreground">套餐开通 / 改期与用户用量概览</p>
        </div>
        <AdminConsole />
      </div>
    </div>
  );
}
