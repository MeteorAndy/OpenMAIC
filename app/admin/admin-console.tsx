'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

// Shapes mirror the compiled backend's /api/admin/* routes
// (backend/src/routes/admin.ts, apiSuccess spreads data at the top level).
interface AdminPlan {
  id: string;
  name: string;
}

interface AdminUser {
  userId: string;
  email: string | null;
  bannedUntil: string | null;
  planId: string | null;
  planName: string | null;
  status: string | null;
  currentPeriodEnd: string | null;
  generations: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  mediaSeconds: number | null;
}

type PlansResponse = { success: true; plans: AdminPlan[] } | { success: false; error?: string };
type UsersResponse =
  | { success: true; periodStart: string; users: AdminUser[] }
  | { success: false; error?: string };
type ActionResponse = { success: true } | { success: false; error?: string };

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

function isBanned(u: AdminUser): boolean {
  return !!u.bannedUntil && new Date(u.bannedUntil).getTime() > Date.now();
}

export function AdminConsole() {
  const [plans, setPlans] = useState<AdminPlan[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [userId, setUserId] = useState('');
  const [planId, setPlanId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [banPending, setBanPending] = useState<string | null>(null);

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

  const filteredUsers = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.email?.toLowerCase().includes(q) || u.userId.toLowerCase().includes(q),
    );
  }, [users, filter]);

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
      const data = (await res.json().catch(() => null)) as ActionResponse | null;
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

  async function onToggleBan(u: AdminUser) {
    const banned = isBanned(u);
    if (banned === false && !window.confirm(`确认封禁 ${u.email ?? u.userId}?其登录与生成权限将立即失效。`)) {
      return;
    }
    setBanPending(u.userId);
    try {
      const res = await fetch(`/api/admin/users/${u.userId}/${banned ? 'unban' : 'ban'}`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => null)) as ActionResponse | null;
      if (!res.ok || !data?.success) {
        window.alert(data && !data.success && data.error ? data.error : '操作失败');
        return;
      }
      await load();
    } finally {
      setBanPending(null);
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>;

  return (
    <div className="space-y-8">
      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">注册用户({users.length})</h2>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按邮箱 / 用户 ID 过滤"
            className="w-64 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-2 pr-4 font-medium">用户</th>
              <th className="py-2 pr-4 font-medium">套餐</th>
              <th className="py-2 pr-4 font-medium">到期时间</th>
              <th className="py-2 pr-4 font-medium">本期用量(生成 / Tokens / 媒体秒)</th>
              <th className="py-2 font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {filteredUsers.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-muted-foreground">
                  无匹配用户
                </td>
              </tr>
            )}
            {filteredUsers.map((u) => (
              <tr key={u.userId} className="border-b last:border-0">
                <td className="py-2 pr-4">
                  <div>{u.email ?? '—'}</div>
                  <div className="font-mono text-xs text-muted-foreground" title={u.userId}>
                    {u.userId.slice(0, 8)}…
                  </div>
                </td>
                <td className="py-2 pr-4">
                  {u.planName ?? u.planId ?? 'Free(默认)'}
                  {isBanned(u) && <span className="ml-2 text-xs text-destructive">已封禁</span>}
                </td>
                <td className="py-2 pr-4">{formatDate(u.currentPeriodEnd)}</td>
                <td className="py-2 pr-4">
                  {(u.generations ?? 0).toLocaleString()} /{' '}
                  {((u.inputTokens ?? 0) + (u.outputTokens ?? 0)).toLocaleString()} /{' '}
                  {(u.mediaSeconds ?? 0).toLocaleString()}
                </td>
                <td className="py-2">
                  <button
                    onClick={() => onToggleBan(u)}
                    disabled={banPending === u.userId}
                    className={`rounded-md border px-3 py-1 text-xs disabled:opacity-50 ${
                      isBanned(u) ? '' : 'border-destructive text-destructive'
                    }`}
                  >
                    {banPending === u.userId ? '…' : isBanned(u) ? '解封' : '封禁'}
                  </button>
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
            placeholder="用户 ID(上表悬停邮箱下方查看)"
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
