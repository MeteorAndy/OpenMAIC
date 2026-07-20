'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';

// Shapes mirror the compiled backend's /api/admin/* routes
// (backend/src/routes/admin.ts, apiSuccess spreads data at the top level).
interface AdminOverview {
  periodStart: string;
  totalUsers: number;
  bannedUsers: number;
  paidUsers: number;
  generations: number;
  /** postgres bigint serializes to string — display via Number(tokens). */
  tokens: string;
  mediaSeconds: number;
}

interface AdminPlan {
  id: string;
  name: string;
  priceMonthlyCents: number;
  maxGenerationsPerPeriod: number | null;
  maxTokensPerPeriod: number | null;
  maxMediaSecondsPerPeriod: number | null;
  isActive: boolean;
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

interface UsageRow {
  id: string;
  userId: string;
  periodStart: string;
  generations: number;
  inputTokens: number;
  outputTokens: number;
  mediaSeconds: number;
  updatedAt: string;
}

/** Editable plan fields; quotas/price as strings, '' quota = null = 不限. */
interface PlanDraft {
  name: string;
  priceYuan: string;
  maxGenerations: string;
  maxTokens: string;
  maxMediaSeconds: string;
  isActive: boolean;
}

type AuditAction = 'subscription.set' | 'user.ban' | 'user.unban' | 'plan.update';

/** Plan row snapshot embedded in plan.update audit details. */
interface AuditPlanSnapshot {
  name: string;
  priceMonthlyCents: number;
  maxGenerationsPerPeriod: number | null;
  maxTokensPerPeriod: number | null;
  maxMediaSecondsPerPeriod: number | null;
  isActive: boolean;
}

interface AuditEntryBase {
  id: string;
  targetType: 'user' | 'plan';
  targetId: string;
  createdAt: string;
  actorUserId: string;
  actorEmail: string | null;
  targetEmail: string | null;
}

/** detail shape is discriminated by action (null for ban/unban). */
type AuditEntry =
  | (AuditEntryBase & {
      action: 'subscription.set';
      detail: { fromPlanId: string | null; toPlanId: string } | null;
    })
  | (AuditEntryBase & {
      action: 'plan.update';
      detail: { before: AuditPlanSnapshot; after: AuditPlanSnapshot } | null;
    })
  | (AuditEntryBase & { action: 'user.ban' | 'user.unban'; detail: null });

type OverviewResponse =
  | ({ success: true } & AdminOverview)
  | { success: false; error?: string };
type PlansResponse = { success: true; plans: AdminPlan[] } | { success: false; error?: string };
type UsersResponse =
  | { success: true; periodStart: string; users: AdminUser[] }
  | { success: false; error?: string };
type UsageResponse =
  | { success: true; userId: string; usage: UsageRow[] }
  | { success: false; error?: string };
type PlanSaveResponse =
  | { success: true; plan: AdminPlan }
  | { success: false; error?: string };
type ActionResponse = { success: true } | { success: false; error?: string };
type AuditResponse =
  | { success: true; total: number; entries: AuditEntry[] }
  | { success: false; error?: string };

const AUDIT_PAGE_SIZE = 50;

const ACTION_LABELS: Record<AuditAction, string> = {
  'subscription.set': '开通/改期',
  'user.ban': '封禁',
  'user.unban': '解封',
  'plan.update': '修改套餐',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** periodStart is a UTC month start — render as YYYY-MM in UTC to avoid TZ shift. */
function formatMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** createdAt arrives as "2026-07-20 03:09:58.645909" — render local time to the minute. */
function formatDateTimeMinute(raw: string): string {
  const d = new Date(raw.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isBanned(u: AdminUser): boolean {
  return !!u.bannedUntil && new Date(u.bannedUntil).getTime() > Date.now();
}

function draftOf(p: AdminPlan): PlanDraft {
  return {
    name: p.name,
    priceYuan: String(p.priceMonthlyCents / 100),
    maxGenerations: p.maxGenerationsPerPeriod === null ? '' : String(p.maxGenerationsPerPeriod),
    maxTokens: p.maxTokensPerPeriod === null ? '' : String(p.maxTokensPerPeriod),
    maxMediaSeconds: p.maxMediaSecondsPerPeriod === null ? '' : String(p.maxMediaSecondsPerPeriod),
    isActive: p.isActive,
  };
}

function isDirty(d: PlanDraft, p: AdminPlan): boolean {
  const o = draftOf(p);
  return (
    d.name !== o.name ||
    d.priceYuan !== o.priceYuan ||
    d.maxGenerations !== o.maxGenerations ||
    d.maxTokens !== o.maxTokens ||
    d.maxMediaSeconds !== o.maxMediaSeconds ||
    d.isActive !== o.isActive
  );
}

/** '' -> null (不限); positive int -> number; anything else -> undefined (invalid). */
function parseQuota(s: string): number | null | undefined {
  if (s.trim() === '') return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function formatQuotaValue(v: number | null): string {
  return v === null ? '不限' : v.toLocaleString();
}

/** Field-by-field diff of a plan.update detail; only changed fields, joined by '、'. */
function diffPlanSnapshot(before: AuditPlanSnapshot, after: AuditPlanSnapshot): string {
  const parts: string[] = [];
  if (before.name !== after.name) parts.push(`名称: ${before.name} → ${after.name}`);
  if (before.priceMonthlyCents !== after.priceMonthlyCents) {
    parts.push(`价格: ¥${before.priceMonthlyCents / 100} → ¥${after.priceMonthlyCents / 100}`);
  }
  if (before.maxGenerationsPerPeriod !== after.maxGenerationsPerPeriod) {
    parts.push(
      `月生成次数: ${formatQuotaValue(before.maxGenerationsPerPeriod)} → ${formatQuotaValue(after.maxGenerationsPerPeriod)}`,
    );
  }
  if (before.maxTokensPerPeriod !== after.maxTokensPerPeriod) {
    parts.push(
      `月 Tokens: ${formatQuotaValue(before.maxTokensPerPeriod)} → ${formatQuotaValue(after.maxTokensPerPeriod)}`,
    );
  }
  if (before.maxMediaSecondsPerPeriod !== after.maxMediaSecondsPerPeriod) {
    parts.push(
      `媒体秒: ${formatQuotaValue(before.maxMediaSecondsPerPeriod)} → ${formatQuotaValue(after.maxMediaSecondsPerPeriod)}`,
    );
  }
  if (before.isActive !== after.isActive) {
    parts.push(`上架: ${before.isActive ? '是' : '否'} → ${after.isActive ? '是' : '否'}`);
  }
  return parts.length > 0 ? parts.join('、') : '无字段变化';
}

function renderAuditDetail(entry: AuditEntry): string {
  switch (entry.action) {
    case 'subscription.set': {
      const d = entry.detail;
      return d ? `${d.fromPlanId ?? '无'} → ${d.toPlanId}` : '—';
    }
    case 'plan.update': {
      const d = entry.detail;
      return d ? diffPlanSnapshot(d.before, d.after) : '—';
    }
    default:
      return '—';
  }
}

export function AdminConsole() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
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
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [usageCache, setUsageCache] = useState<Record<string, UsageRow[]>>({});
  const [usageLoading, setUsageLoading] = useState<string | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [planDrafts, setPlanDrafts] = useState<Record<string, PlanDraft>>({});
  const [planSaving, setPlanSaving] = useState<Record<string, boolean>>({});
  const [planMessages, setPlanMessages] = useState<Record<string, { ok: boolean; text: string }>>(
    {},
  );
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  // Fetches one page of the audit log. Errors stay section-local (never thrown),
  // so this is safe to include in load()'s Promise.all.
  const fetchAudit = useCallback(async (offset: number, append: boolean) => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const res = await fetch(`/api/admin/audit-log?limit=${AUDIT_PAGE_SIZE}&offset=${offset}`);
      const data = (await res.json().catch(() => null)) as AuditResponse | null;
      if (!res.ok || !data?.success) {
        throw new Error(data && !data.success && data.error ? data.error : '操作日志加载失败');
      }
      setAuditTotal(data.total);
      setAuditEntries((prev) => (append ? [...prev, ...data.entries] : data.entries));
    } catch (err) {
      setAuditError(err instanceof Error ? err.message : '操作日志加载失败');
    } finally {
      setAuditLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [overviewRes, plansRes, usersRes] = await Promise.all([
        fetch('/api/admin/overview'),
        fetch('/api/admin/plans'),
        fetch('/api/admin/users'),
        // Resets the log to page 1 on every load; never rejects on its own.
        fetchAudit(0, false),
      ]);
      const overviewJson = (await overviewRes.json().catch(() => null)) as OverviewResponse | null;
      const plansJson = (await plansRes.json().catch(() => null)) as PlansResponse | null;
      const usersJson = (await usersRes.json().catch(() => null)) as UsersResponse | null;
      if (!overviewRes.ok || !overviewJson?.success) {
        throw new Error(
          overviewJson && !overviewJson.success && overviewJson.error
            ? overviewJson.error
            : '总览加载失败',
        );
      }
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
      // overviewJson is narrowed to the success variant; the extra `success`
      // key is structurally compatible with AdminOverview.
      setOverview(overviewJson);
      setPlans(plansJson.plans);
      setPlanDrafts(
        Object.fromEntries(plansJson.plans.map((p): [string, PlanDraft] => [p.id, draftOf(p)])),
      );
      setUsers(usersJson.users);
      setPlanId((prev) => prev || plansJson.plans[0]?.id || '');
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [fetchAudit]);

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
    if (
      banned === false &&
      !window.confirm(`确认封禁 ${u.email ?? u.userId}?其登录与生成权限将立即失效。`)
    ) {
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

  async function onToggleUsage(u: AdminUser) {
    if (expandedUserId === u.userId) {
      setExpandedUserId(null);
      setUsageError(null);
      return;
    }
    setExpandedUserId(u.userId);
    setUsageError(null);
    if (usageCache[u.userId]) return;
    setUsageLoading(u.userId);
    try {
      const res = await fetch(`/api/admin/users/${u.userId}/usage`);
      const data = (await res.json().catch(() => null)) as UsageResponse | null;
      if (!res.ok || !data?.success) {
        setUsageError(data && !data.success && data.error ? data.error : '用量加载失败');
        return;
      }
      setUsageCache((prev) => ({ ...prev, [u.userId]: data.usage }));
    } catch {
      setUsageError('网络错误,请稍后重试');
    } finally {
      setUsageLoading(null);
    }
  }

  function updateDraft(id: string, patch: Partial<PlanDraft>) {
    setPlanDrafts((prev) => {
      const base = prev[id];
      if (!base) return prev;
      return { ...prev, [id]: { ...base, ...patch } };
    });
    setPlanMessages((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function setPlanMessage(id: string, ok: boolean, text: string) {
    setPlanMessages((prev) => ({ ...prev, [id]: { ok, text } }));
  }

  async function onSavePlan(p: AdminPlan) {
    const d = planDrafts[p.id];
    if (!d) return;
    const priceYuan = Number(d.priceYuan);
    if (!Number.isFinite(priceYuan) || priceYuan < 0) {
      setPlanMessage(p.id, false, '价格必须是非负数字(单位:元)');
      return;
    }
    const maxGenerations = parseQuota(d.maxGenerations);
    const maxTokens = parseQuota(d.maxTokens);
    const maxMediaSeconds = parseQuota(d.maxMediaSeconds);
    if (maxGenerations === undefined || maxTokens === undefined || maxMediaSeconds === undefined) {
      setPlanMessage(p.id, false, '额度必须是正整数,留空表示不限');
      return;
    }
    setPlanSaving((prev) => ({ ...prev, [p.id]: true }));
    setPlanMessages((prev) => {
      if (!(p.id in prev)) return prev;
      const next = { ...prev };
      delete next[p.id];
      return next;
    });
    try {
      const res = await fetch(`/api/admin/plans/${p.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: d.name,
          priceMonthlyCents: Math.round(priceYuan * 100),
          maxGenerationsPerPeriod: maxGenerations,
          maxTokensPerPeriod: maxTokens,
          maxMediaSecondsPerPeriod: maxMediaSeconds,
          isActive: d.isActive,
        }),
      });
      const data = (await res.json().catch(() => null)) as PlanSaveResponse | null;
      if (!res.ok || !data?.success) {
        setPlanMessage(p.id, false, data && !data.success && data.error ? data.error : '保存失败');
        return;
      }
      setPlans((prev) => prev.map((x) => (x.id === p.id ? data.plan : x)));
      setPlanDrafts((prev) => ({ ...prev, [p.id]: draftOf(data.plan) }));
      setPlanMessage(p.id, true, '已保存');
    } catch {
      setPlanMessage(p.id, false, '网络错误,请稍后重试');
    } finally {
      setPlanSaving((prev) => ({ ...prev, [p.id]: false }));
    }
  }

  function onLoadMoreAudit() {
    void fetchAudit(auditEntries.length, true);
  }

  if (loading) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>;

  const inputClass =
    'w-full rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary';

  return (
    <div className="space-y-8">
      {overview && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          {[
            { label: '注册用户总数', value: overview.totalUsers.toLocaleString() },
            { label: '付费用户', value: overview.paidUsers.toLocaleString() },
            { label: '已封禁', value: overview.bannedUsers.toLocaleString() },
            { label: '本月生成次数', value: overview.generations.toLocaleString() },
            { label: '本月 Tokens', value: Number(overview.tokens).toLocaleString() },
          ].map((k) => (
            <div key={k.label} className="rounded-xl border bg-card p-4 shadow-sm">
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className="mt-1 text-2xl font-semibold">{k.value}</p>
            </div>
          ))}
        </div>
      )}

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
        <div className="overflow-x-auto">
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
                <Fragment key={u.userId}>
                  <tr className="border-b last:border-0">
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
                      <div className="flex gap-2">
                        <button
                          onClick={() => onToggleUsage(u)}
                          className="rounded-md border px-3 py-1 text-xs hover:bg-accent"
                        >
                          {expandedUserId === u.userId ? '收起' : '用量'}
                        </button>
                        <button
                          onClick={() => onToggleBan(u)}
                          disabled={banPending === u.userId}
                          className={`rounded-md border px-3 py-1 text-xs disabled:opacity-50 ${
                            isBanned(u) ? '' : 'border-destructive text-destructive'
                          }`}
                        >
                          {banPending === u.userId ? '…' : isBanned(u) ? '解封' : '封禁'}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedUserId === u.userId && (
                    <tr className="border-b last:border-0 bg-muted/30">
                      <td colSpan={5} className="px-4 py-3">
                        {usageLoading === u.userId ? (
                          <p className="text-xs text-muted-foreground">用量加载中…</p>
                        ) : usageError ? (
                          <p className="text-xs text-destructive">{usageError}</p>
                        ) : (usageCache[u.userId]?.length ?? 0) === 0 ? (
                          <p className="text-xs text-muted-foreground">暂无用量记录</p>
                        ) : (
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b text-left text-muted-foreground">
                                <th className="py-1 pr-4 font-medium">周期</th>
                                <th className="py-1 pr-4 font-medium">生成次数</th>
                                <th className="py-1 pr-4 font-medium">Tokens(input+output)</th>
                                <th className="py-1 font-medium">媒体秒</th>
                              </tr>
                            </thead>
                            <tbody>
                              {usageCache[u.userId].map((r) => (
                                <tr key={r.id} className="border-b last:border-0">
                                  <td className="py-1 pr-4 font-mono">
                                    {formatMonth(r.periodStart)}
                                  </td>
                                  <td className="py-1 pr-4">{r.generations.toLocaleString()}</td>
                                  <td className="py-1 pr-4">
                                    {(r.inputTokens + r.outputTokens).toLocaleString()}
                                  </td>
                                  <td className="py-1">{r.mediaSeconds.toLocaleString()}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold">套餐管理</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-4 font-medium">名称</th>
                <th className="py-2 pr-4 font-medium">价格(¥/月)</th>
                <th className="py-2 pr-4 font-medium">月生成次数</th>
                <th className="py-2 pr-4 font-medium">月 Tokens</th>
                <th className="py-2 pr-4 font-medium">媒体秒</th>
                <th className="py-2 pr-4 font-medium">上架</th>
                <th className="py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => {
                const d = planDrafts[p.id];
                if (!d) return null;
                const dirty = isDirty(d, p);
                const saving = !!planSaving[p.id];
                const msg = planMessages[p.id];
                return (
                  <Fragment key={p.id}>
                    <tr className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        <input
                          type="text"
                          value={d.name}
                          onChange={(e) => updateDraft(p.id, { name: e.target.value })}
                          className={`${inputClass} w-28`}
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={d.priceYuan}
                          onChange={(e) => updateDraft(p.id, { priceYuan: e.target.value })}
                          className={`${inputClass} w-24`}
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <input
                          type="number"
                          min="1"
                          value={d.maxGenerations}
                          placeholder="不限"
                          onChange={(e) => updateDraft(p.id, { maxGenerations: e.target.value })}
                          className={`${inputClass} w-28`}
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <input
                          type="number"
                          min="1"
                          value={d.maxTokens}
                          placeholder="不限"
                          onChange={(e) => updateDraft(p.id, { maxTokens: e.target.value })}
                          className={`${inputClass} w-32`}
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <input
                          type="number"
                          min="1"
                          value={d.maxMediaSeconds}
                          placeholder="不限"
                          onChange={(e) => updateDraft(p.id, { maxMediaSeconds: e.target.value })}
                          className={`${inputClass} w-28`}
                        />
                      </td>
                      <td className="py-2 pr-4">
                        <input
                          type="checkbox"
                          checked={d.isActive}
                          onChange={(e) => updateDraft(p.id, { isActive: e.target.checked })}
                          className="h-4 w-4"
                        />
                      </td>
                      <td className="py-2">
                        <button
                          onClick={() => onSavePlan(p)}
                          disabled={!dirty || saving}
                          className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                        >
                          {saving ? '保存中…' : '保存'}
                        </button>
                      </td>
                    </tr>
                    {msg && (
                      <tr className="border-b last:border-0">
                        <td
                          colSpan={7}
                          className={`py-1 text-xs ${msg.ok ? 'text-muted-foreground' : 'text-destructive'}`}
                        >
                          {msg.text}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">额度留空表示不限;价格单位为元。</p>
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

      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold">操作日志</h2>
        {auditError && <p className="mb-3 text-sm text-destructive">{auditError}</p>}
        {auditEntries.length === 0 && !auditError && (
          <p className="text-sm text-muted-foreground">
            {auditLoading ? '加载中…' : '暂无操作日志'}
          </p>
        )}
        {auditEntries.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">时间</th>
                    <th className="py-2 pr-4 font-medium">操作者</th>
                    <th className="py-2 pr-4 font-medium">动作</th>
                    <th className="py-2 pr-4 font-medium">目标</th>
                    <th className="py-2 font-medium">详情</th>
                  </tr>
                </thead>
                <tbody>
                  {auditEntries.map((e) => (
                    <tr key={e.id} className="border-b last:border-0">
                      <td className="whitespace-nowrap py-2 pr-4">
                        {formatDateTimeMinute(e.createdAt)}
                      </td>
                      <td className="py-2 pr-4">
                        {e.actorEmail ?? (
                          <span className="font-mono text-xs" title={e.actorUserId}>
                            {e.actorUserId.slice(0, 8)}…
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4">{ACTION_LABELS[e.action] ?? e.action}</td>
                      <td className="py-2 pr-4">
                        {e.targetType === 'plan'
                          ? `套餐 ${e.targetId}`
                          : (e.targetEmail ?? e.targetId)}
                      </td>
                      <td className="py-2 text-muted-foreground">{renderAuditDetail(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex items-center gap-3">
              {auditEntries.length < auditTotal && (
                <button
                  onClick={onLoadMoreAudit}
                  disabled={auditLoading}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                >
                  {auditLoading ? '加载中…' : '加载更多'}
                </button>
              )}
              <p className="text-xs text-muted-foreground">
                已加载 {auditEntries.length} / 共 {auditTotal}
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
