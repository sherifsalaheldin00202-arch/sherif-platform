// عميل بسيط للصفحات: await api('/me') أو await api('/wallet/topup', {amount: 200})
window.api = async (path, body, method) => {
  const r = await fetch('/api' + path, {
    method: method || (body ? 'POST' : 'GET'), credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'حصل خطأ'), { status: r.status });
  return j;
};
// مثال شحن الرصيد:  const { checkoutUrl } = await api('/wallet/topup', { amount: 200 }); location.href = checkoutUrl;
