'use client';

import { useState } from 'react';

type CheckoutResponse =
  | { success: true; checkoutUrl: string }
  | { success: false; errorCode?: string; error?: string };

export function CheckoutButton({ planId, label }: { planId: string; label: string }) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onCheckout() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId }),
      });
      if (res.status === 401) {
        window.location.href = '/login?redirect=/pricing';
        return;
      }
      const data = (await res.json().catch(() => null)) as CheckoutResponse | null;
      if (data && data.success) {
        window.location.href = data.checkoutUrl;
        return;
      }
      if (res.status === 501 || data?.errorCode === 'PROVIDER_DISABLED') {
        setMessage('线上支付暂未开通,请扫描页脚二维码或联系运营开通');
        return;
      }
      setMessage(data?.error ?? '下单失败,请稍后重试');
    } catch {
      setMessage('网络错误,请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        onClick={onCheckout}
        disabled={loading}
        className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {loading ? '处理中…' : label}
      </button>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  );
}
