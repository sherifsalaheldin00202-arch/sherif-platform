import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { q, one, tx, credit, debit, hashPw, checkPw, newSession, dropSession, userByToken, limit, cleanup, HttpError } from './db.js';

const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const DUMMY = hashPw('dummy');
const PHONE = /^01[0125]\d{8}$/;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const METHODS = ['vodafone_cash', 'instapay'];

// ---------- أدوات ----------
const int = (v, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'قيمة غير صالحة');
  return n;
};
const id = (v) => int(v, 1, 2147483647);
const cookie = (req, n) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === n)?.[1];
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' || (process.env.PUBLIC_URL || '').startsWith('https');
const cookieHdr = (req, t, age) => `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${isHttps(req) ? '; Secure' : ''}`;
// على Vercel الـ x-forwarded-for بتحطه Vercel نفسها. محليًا بنرجع لعنوان الاتصال.
const clientIp = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
const send = (res, status, obj, cookies = []) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((ok, no) => {
  // Vercel بتقرا الـ body وتحطه في req.body قبل ما الكود يشتغل
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return ok(req.body ? JSON.parse(req.body) : {}); } catch { return no(new HttpError(400, 'JSON غير صالح')); } }
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return ok(req.body);
  }
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 1e5) { no(new HttpError(413, 'الطلب كبير')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new HttpError(400, 'JSON غير صالح')); } });
});

// ---------- الراوتر ----------
// roles: null = عام | [] = أي مستخدم مسجّل | ['teacher',..] = أدوار محددة
const routes = [];
const route = (method, pat, roles, fn) =>
  routes.push({ method, roles, fn, re: new RegExp('^' + pat.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

// بيخدم مسارات /api/* بس. ده اللي بتناديه Vercel (api/index.js).
export async function handleApi(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'غير موجود');
    // حماية CSRF: الطلبات المعدِّلة لازم تبقى JSON (فورم من موقع تاني مش هيقدر يبعت كده) + SameSite=Lax
    if (req.method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json'))
      throw new HttpError(415, 'Content-Type لازم يكون application/json');
    const ctx = { req, query: url.searchParams, ip: clientIp(req), headers: [],
      params: url.pathname.match(r.re).groups || {}, body: req.method === 'GET' ? {} : await readBody(req) };
    if (r.roles) {
      ctx.u = await userByToken(cookie(req, 'sid'));
      if (!ctx.u) throw new HttpError(401, 'سجّل دخولك الأول');
      if (r.roles.length && !r.roles.includes(ctx.u.role)) throw new HttpError(403, 'غير مسموح');
    }
    send(res, 200, await r.fn(ctx), ctx.headers);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e); send(res, 500, { error: 'خطأ داخلي' });
  }
}

async function serveStatic(p, res) { // للتشغيل المحلي فقط. على Vercel مجلد public بيتقدّم تلقائيًا
  let f;
  try { f = path.normalize(path.join(PUB, p === '/' ? '/Main.dc.html' : decodeURIComponent(p))); } catch { f = ''; }
  if (!f.startsWith(PUB + path.sep)) return send(res, 403, { error: 'ممنوع' });
  try {
    const b = await readFile(f);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(b);
  } catch { send(res, 404, { error: 'غير موجود' }); }
}

// ---------- الحسابات ----------
route('POST', '/api/auth/register', null, async ({ req, body, ip, headers }) => {
  await limit('reg:' + ip, 10, 36e5);
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'الاسم غير صالح');
  if (!PHONE.test(body.phone)) throw new HttpError(400, 'رقم الموبايل غير صالح');
  if (String(body.password || '').length < 8) throw new HttpError(400, 'كلمة السر لازم ٨ حروف على الأقل');
  const grade = int(body.grade, 1, 3);
  try {
    const u = await one("INSERT INTO users(name,phone,pass_hash,role,grade) VALUES($1,$2,$3,'student',$4) RETURNING id", [name, body.phone, hashPw(body.password), grade]);
    headers.push(cookieHdr(req, await newSession(u.id), 2592000));
    return { ok: true };
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'الرقم ده مسجّل بالفعل');
    throw e;
  }
});
route('POST', '/api/auth/login', null, async ({ req, body, ip, headers }) => {
  await limit('login:' + ip + ':' + body.phone, 8, 6e5);
  const u = await one('SELECT id,pass_hash FROM users WHERE phone=$1', [String(body.phone || '')]);
  const ok = checkPw(String(body.password || ''), u ? u.pass_hash : DUMMY);
  if (!u || !ok) throw new HttpError(401, 'الرقم أو كلمة السر غير صحيحة');
  headers.push(cookieHdr(req, await newSession(u.id), 2592000));
  if (Math.random() < 0.05) cleanup().catch(() => {});
  return { ok: true };
});
route('POST', '/api/auth/logout', [], async ({ req, headers }) => { await dropSession(cookie(req, 'sid')); headers.push(cookieHdr(req, '', 0)); return { ok: true }; });
route('GET', '/api/me', [], ({ u }) => u); // balance بالقروش

// ---------- الكورسات والمحفظة ----------
route('GET', '/api/courses', [], async ({ u }) => ({
  courses: (await q(`SELECT c.id,c.title,c.grade,c.price,
    EXISTS(SELECT 1 FROM enrollments e WHERE e.user_id=$1 AND e.course_id=c.id) AS owned
    FROM courses c WHERE c.published ORDER BY c.id`, [u.id])).rows
}));
route('POST', '/api/courses/:id/buy', ['student'], ({ u, params }) => tx(async (t) => {
  const c = await t.one('SELECT id,price FROM courses WHERE id=$1 AND published', [id(params.id)]);
  if (!c) throw new HttpError(404, 'الكورس غير متاح');
  if (await t.one('SELECT 1 AS x FROM enrollments WHERE user_id=$1 AND course_id=$2', [u.id, c.id])) throw new HttpError(409, 'أنت مشترك بالفعل');
  await debit(t, u.id, c.price, 'course', String(c.id));
  await t.q("INSERT INTO enrollments(user_id,course_id,source) VALUES($1,$2,'wallet')", [u.id, c.id]);
  return { ok: true, balance: (await t.one('SELECT balance FROM users WHERE id=$1', [u.id])).balance };
}));
route('POST', '/api/codes/redeem', ['student'], async ({ u, body }) => {
  await limit('redeem:' + u.id, 10, 36e5);
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return tx(async (t) => {
    const c = await t.one('SELECT course_id FROM codes WHERE code=$1', [code]);
    const r = await t.q('UPDATE codes SET used_by=$1,used_at=now() WHERE code=$2 AND used_by IS NULL', [u.id, code]);
    if (!c || !r.count) throw new HttpError(404, 'الكود غير صالح أو مستخدم');
    await t.q("INSERT INTO enrollments(user_id,course_id,source) VALUES($1,$2,'code') ON CONFLICT DO NOTHING", [u.id, c.course_id]);
    return { ok: true, courseId: c.course_id };
  });
});

// ---------- شحن الرصيد يدويًا (فودافون كاش / إنستا باي) ----------
// أرقام التحويل بتتضبط من متغيرات البيئة (مش مكتوبة في الكود)
route('GET', '/api/payment-info', [], () => ({
  vodafone_cash: process.env.VODAFONE_CASH_NUMBER || null,
  instapay: process.env.INSTAPAY_HANDLE || null,
  min: 20, max: 5000
}));
route('POST', '/api/charge-requests', ['student'], async ({ u, body }) => {
  await limit('cr:' + u.id, 10, 36e5);
  const amount = int(body.amount, 20, 5000) * 100; // الطالب بيبعت جنيهات
  if (!METHODS.includes(body.method)) throw new HttpError(400, 'طريقة غير صالحة');
  const reference = String(body.reference || '').trim().slice(0, 40);
  if (reference.length < 3) throw new HttpError(400, 'اكتب رقم العملية أو الرقم اللي حوّلت منه');
  const r = await one('INSERT INTO charge_requests(user_id,amount,method,reference) VALUES($1,$2,$3,$4) RETURNING id', [u.id, amount, body.method, reference]);
  return { ok: true, id: r.id };
});
route('GET', '/api/charge-requests', ['student'], async ({ u }) => ({
  requests: (await q('SELECT id,amount,method,reference,status,created_at FROM charge_requests WHERE user_id=$1 ORDER BY id DESC LIMIT 30', [u.id])).rows
}));
route('GET', '/api/teacher/charge-requests', ['teacher', 'supervisor'], async () => ({
  requests: (await q(`SELECT r.id,r.amount,r.method,r.reference,r.created_at,u.name,u.phone FROM charge_requests r
    JOIN users u ON u.id=r.user_id WHERE r.status='pending' ORDER BY r.id`)).rows
}));
route('POST', '/api/teacher/charge-requests/:id/:action', ['teacher', 'supervisor'], ({ u, params }) => tx(async (t) => {
  if (!['approve', 'reject'].includes(params.action)) throw new HttpError(404, 'غير موجود');
  const cr = await t.one('SELECT * FROM charge_requests WHERE id=$1', [id(params.id)]);
  if (!cr) throw new HttpError(404, 'غير موجود');
  const st = params.action === 'approve' ? 'approved' : 'rejected';
  // الـ UPDATE الشرطي بينجح مرة واحدة بس مهما اتبعت الطلب أكتر من مرة
  const r = await t.q("UPDATE charge_requests SET status=$1,reviewed_by=$2,reviewed_at=now() WHERE id=$3 AND status='pending'", [st, u.id, cr.id]);
  if (!r.count) throw new HttpError(409, 'الطلب اتراجع بالفعل');
  if (st === 'approved') await credit(t, cr.user_id, cr.amount, 'manual_charge', 'cr:' + cr.id);
  return { ok: true };
}));

// ---------- المستر ----------
const own = async (u, cid) => {
  const c = await one('SELECT id FROM courses WHERE id=$1 AND teacher_id=$2', [id(cid), u.id]);
  if (!c) throw new HttpError(404, 'كورس غير موجود');
  return c;
};
route('POST', '/api/teacher/courses', ['teacher'], async ({ u, body }) => {
  const title = String(body.title || '').trim();
  if (title.length < 3 || title.length > 100) throw new HttpError(400, 'العنوان غير صالح');
  const r = await one('INSERT INTO courses(teacher_id,title,grade,price) VALUES($1,$2,$3,$4) RETURNING id', [u.id, title, int(body.grade, 1, 3), int(body.price, 0, 5000) * 100]);
  return { id: r.id };
});
route('POST', '/api/teacher/courses/:id/publish', ['teacher'], async ({ u, params, body }) => {
  await own(u, params.id);
  await q('UPDATE courses SET published=$1 WHERE id=$2', [!!body.published, params.id]);
  return { ok: true };
});
route('POST', '/api/teacher/codes', ['teacher'], async ({ u, body }) => {
  await own(u, body.courseId);
  const n = int(body.count, 1, 200);
  const codes = await tx(async (t) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const code = Array.from(randomBytes(15), (b) => ALPHA[b % 32]).join('');
      await t.q('INSERT INTO codes(code,course_id,created_by) VALUES($1,$2,$3)', [code, body.courseId, u.id]);
      out.push(code);
    }
    return out;
  });
  return { codes };
});

// ---------- تشغيل محلي ----------
export const createServer = () => http.createServer((req, res) =>
  new URL(req.url, 'http://x').pathname.startsWith('/api/') ? handleApi(req, res) : serveStatic(new URL(req.url, 'http://x').pathname, res));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT || 3000;
  createServer().listen(port, () => console.log('http://localhost:' + port + (process.env.DATABASE_URL ? '' : '  (قاعدة بيانات محلية مؤقتة)')));
}
