// بيشتغل على Postgres محلي (PGlite) من غير ما يلمس Supabase: npm test
// TEST_DATABASE_URL (اختياري): يجرّب على Postgres حقيقي بدل PGlite. لازم قاعدة فاضية.
delete process.env.DATABASE_URL;
if (process.env.TEST_DATABASE_URL) { process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; process.env.AUTO_MIGRATE = '1'; }
process.env.VODAFONE_CASH_NUMBER = '01000000000';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createServer } = await import('./server.js');
const { q, one, hashPw, closeDb } = await import('./db.js');

const srv = createServer(); await new Promise((r) => srv.listen(0, r));
const base = 'http://127.0.0.1:' + srv.address().port;
test.after(async () => { srv.close(); await closeDb(); });
const call = async (path, { body, cookie, method } = {}) => {
  const r = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => ({})), cookie: (r.headers.getSetCookie()[0] || '').split(';')[0] };
};
let S, T;
const bal = async () => (await call('/api/me', { cookie: S })).j.balance;

test('تسجيل ودخول وحماية الصفحات', async () => {
  assert.equal((await call('/api/me')).status, 401);
  const r = await call('/api/auth/register', { body: { name: 'طالب تجريبي', phone: '01012345678', password: 'password123', grade: 3 } });
  assert.equal(r.status, 200); S = r.cookie;
  assert.equal((await call('/api/auth/register', { body: { name: 'طالب', phone: '01012345678', password: 'password123', grade: 3 } })).status, 409);
  assert.equal((await call('/api/auth/login', { body: { phone: '01012345678', password: 'غلط غلط غلط' } })).status, 401);
  assert.equal((await call('/api/auth/login', { body: { phone: '01012345678', password: 'password123' } })).status, 200);
  await q("INSERT INTO users(name,phone,pass_hash,role) VALUES('مستر','01099999999',$1,'teacher')", [hashPw('teacherpass1')]);
  T = (await call('/api/auth/login', { body: { phone: '01099999999', password: 'teacherpass1' } })).cookie;
  assert.equal((await call('/api/teacher/codes', { cookie: S, body: { courseId: 1, count: 1 } })).status, 403);
  assert.equal((await call('/api/auth/logout', { cookie: S, body: {} })).status, 200);
  assert.equal((await call('/api/me', { cookie: S })).status, 401); // الجلسة اتمسحت
  S = (await call('/api/auth/login', { body: { phone: '01012345678', password: 'password123' } })).cookie;
});

test('الدفع الأونلاين (Paymob) اتشال بالكامل', async () => {
  assert.equal((await call('/api/wallet/topup', { cookie: S, body: { amount: 100 } })).status, 404);
  assert.equal((await call('/api/paymob/webhook?hmac=x', { body: { obj: {} } })).status, 404);
});

test('معلومات التحويل', async () => {
  const j = (await call('/api/payment-info', { cookie: S })).j;
  assert.equal(j.vodafone_cash, '01000000000'); assert.equal(j.instapay, null);
});

test('طلبات الشحن اليدوي: الموافقة مرة واحدة، والرفض بيحفظ الحالة', async () => {
  assert.equal(await bal(), 0);
  assert.equal((await call('/api/charge-requests', { cookie: S, body: { amount: 50, method: 'fawry', reference: '0101' } })).status, 400);
  assert.equal((await call('/api/charge-requests', { cookie: S, body: { amount: 5, method: 'instapay', reference: '0101' } })).status, 400);
  assert.equal((await call('/api/charge-requests', { cookie: S, body: { amount: 50, method: 'instapay', reference: '' } })).status, 400);
  const id = (await call('/api/charge-requests', { cookie: S, body: { amount: 50, method: 'vodafone_cash', reference: '01012345' } })).j.id;
  assert.equal((await call(`/api/teacher/charge-requests/${id}/approve`, { cookie: S, body: {} })).status, 403);
  const list = (await call('/api/teacher/charge-requests', { cookie: T })).j.requests;
  assert.equal(list.length, 1); assert.equal(list[0].amount, 5000);
  // اتنين بيوافقوا في نفس اللحظة: واحد بس ينجح والرصيد يتضاف مرة
  const rs = await Promise.all([1, 2, 3].map(() => call(`/api/teacher/charge-requests/${id}/approve`, { cookie: T, body: {} })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(await bal(), 5000);
  const id2 = (await call('/api/charge-requests', { cookie: S, body: { amount: 30, method: 'instapay', reference: 'abc123' } })).j.id;
  assert.equal((await call(`/api/teacher/charge-requests/${id2}/reject`, { cookie: T, body: {} })).status, 200);
  assert.equal((await call(`/api/teacher/charge-requests/${id2}/approve`, { cookie: T, body: {} })).status, 409);
  assert.equal(await bal(), 5000);
  assert.deepEqual((await call('/api/charge-requests', { cookie: S })).j.requests.map((r) => r.status), ['rejected', 'approved']);
  assert.equal((await call('/api/teacher/charge-requests/abc/approve', { cookie: T, body: {} })).status, 400);
  assert.equal((await call('/api/teacher/charge-requests/999/approve', { cookie: T, body: {} })).status, 404);
});

test('شراء كورس بالرصيد + أكواد التفعيل', async () => {
  const c1 = (await call('/api/teacher/courses', { cookie: T, body: { title: 'كورس ١', grade: 3, price: 40 } })).j.id;
  const c2 = (await call('/api/teacher/courses', { cookie: T, body: { title: 'كورس ٢', grade: 3, price: 100 } })).j.id;
  assert.equal((await call(`/api/courses/${c1}/buy`, { cookie: S, body: {} })).status, 404); // لسه مش منشور
  for (const c of [c1, c2]) await call(`/api/teacher/courses/${c}/publish`, { cookie: T, body: { published: true } });
  assert.equal((await call('/api/courses', { cookie: S })).j.courses.length, 2);
  assert.equal((await call(`/api/courses/${c1}/buy`, { cookie: S, body: {} })).j.balance, 1000);
  assert.equal((await call(`/api/courses/${c1}/buy`, { cookie: S, body: {} })).status, 409);
  assert.equal((await call(`/api/courses/${c2}/buy`, { cookie: S, body: {} })).status, 402);
  assert.equal(await bal(), 1000);
  assert.equal((await call('/api/courses', { cookie: S })).j.courses.find((c) => c.id === c1).owned, true);
  const { codes } = (await call('/api/teacher/codes', { cookie: T, body: { courseId: c2, count: 2 } })).j;
  assert.equal(codes[0].length, 15);
  const fmt = codes[0].match(/.{5}/g).join('-').toLowerCase(); // بيقبل الشرطات وحروف صغيرة
  assert.equal((await call('/api/codes/redeem', { cookie: S, body: { code: fmt } })).status, 200);
  assert.equal((await call('/api/codes/redeem', { cookie: S, body: { code: codes[0] } })).status, 404);
  assert.equal((await call('/api/codes/redeem', { cookie: S, body: { code: 'XXXXXXXXXXXXXXX' } })).status, 404);
  assert.equal((await call('/api/teacher/codes', { cookie: S, body: { courseId: c2, count: 1 } })).status, 403);
});

test('الرصيد مش بينزل تحت صفر حتى مع طلبات متزامنة', async () => {
  const c = (await call('/api/teacher/courses', { cookie: T, body: { title: 'كورس ٣', grade: 1, price: 10 } })).j.id;
  await call(`/api/teacher/courses/${c}/publish`, { cookie: T, body: { published: true } });
  const rs = await Promise.all([1, 2, 3].map(() => call(`/api/courses/${c}/buy`, { cookie: S, body: {} })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
  assert.equal(await bal(), 0);
});

test('حد المحاولات', async () => {
  let last;
  for (let i = 0; i < 9; i++) last = (await call('/api/auth/login', { body: { phone: '01077777777', password: 'wrongwrong' } })).status;
  assert.equal(last, 429);
});

test('رفض الطلبات بدون JSON (CSRF) ومسارات الملفات', async () => {
  const r = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: S, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(r.status, 415);
  assert.equal((await fetch(base + '/..%2f..%2fetc/passwd')).status, 403);
  assert.equal((await fetch(base + '/')).status, 200);
});
