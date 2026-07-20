'use client';

import { useCallback, useEffect, useState } from 'react';

// Shapes mirror the compiled backend's /api/admin/* routes
// (backend/src/routes/admin.ts, apiSuccess spreads data at the top level).
interface AdminPlan {
  id: string;
  name: string;
}

interface AdminUser {
  userId: string;
  planId: string;
  planName: string | null;
  status: string;
  currentPeriodEnd: string;
  generations: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  mediaSeconds: number | null;
}

type PlansResponse = { success: true; plans: AdminPlan[] } | { success: false; error?: string };
type UsersResponse =
  | { success: true; periodStart: string; users: AdminUser[] }
  | { success: false; error?: string };
type SubscribeResponse = { success: true } | { success: false; error?: string };

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function AdminConsole() {
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [planId, setPlanId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formMessage, setFormMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [plansRes, usersRes] = await Promise.all([
        fetch('/api/admin/plans'),
        fetch('/api/admin/users'),
      ]);
      const plansJson = (await plansRes.json().catch(() => null)) as PlansResponse | null;
      const usersJson = (await usersRes.json().catch(() => null)) as UsersResponse | null;
      if (!plansRes.ok || !plansJson?.success) {
        throw new Error(
          plansJson && !plansJson.success && plansJson.error ? plansJson.error : '套餐列表加载失败',
        );
      }
      if (!usersRes.ok || !usersJson?.success) {
        throw new Error(
          usersJson && !usersJson.success && usersJson.error ? usersJson.error : '用户列表加载失败',
        );
      }
      setPlans(plansJson.plans);
      setUsers(usersJson.users);
      setPlanId((prev) => prev || plansJson.plans[0]?.id || '');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setFormMessage(null);
    try {
      const res = await fetch('/api/admin/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId.trim(), planId }),
      });
      const data = (await res.json().catch(() => null)) as SubscribeResponse | null;
      if (!res.ok || !data?.success) {
        setFormMessage(data && !data.success && data.error ? data.error : '操作失败,请稍后重试');
        return;
      }
      setFormMessage('已开通 / 改期成功');
      setUserId('');
      await load();
    } catch {
      setFormMessage('网络错误,请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>;

  return (
    <div className="space-y-8">
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2 pr-4 font-medium">用户</th>
              <th className="py-2 pr-4 font-medium">套餐</th>
              <th className="py-2 pr-4 font-medium">状态</th>
              <th className="py-2 pr-4 font-medium">到期时间</th>
              <th className="py-2 font-medium">本期用量(生成 / Tokens / 媒体秒)</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-muted-foreground">
                  暂无订阅用户
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr key={u.userId} className="border-b last:border-0">
                <td className="py-2 pr-4 font-mono" title={u.userId}>
                  {u.userId.slice(0, 8)}…
                </td>
                <td className="py-2 pr-4">{u.planName ?? u.planId}</td>
                <td className="py-2 pr-4">{u.status}</td>
                <td className="py-2 pr-4">{formatDate(u.currentPeriodEnd)}</td>
                <td className="py-2">
                  {(u.generations ?? 0).toLocaleString()} /{' '}
                  {((u.inputTokens ?? 0) + (u.outputTokens ?? 0)).toLocaleString()} /{' '}
                  {(u.mediaSeconds ?? 0).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={onSubmit} className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">手动开通 / 改期</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            required
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="用户 ID"
            className="flex-1 rounded-md border bg-background px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-primary"
          />
          <select
            value={planId}
            onChange={(e) => setPlanId(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
          >
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={submitting || !planId}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {submitting ? '提交中…' : '提交'}
          </button>
        </div>
        {formMessage && <p className="text-sm text-muted-foreground">{formMessage}</p>}
      </form>
    </div>
  );
}
