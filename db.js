import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- الاتصال ----------
// الإنتاج: DATABASE_URL (Supabase، رابط الـ Transaction pooler بورت 6543).
// بدون DATABASE_URL: Postgres محلي داخل Node (PGlite) للتطوير والاختبارات، من غير ما تحتاج Supabase.
let driver;
async function init() {
  if (driver) return driver;
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import('pg');
    const local = /@(localhost|127\.0\.0\.1)/.test(url);
    const pool = new pg.Pool({ connectionString: url, max: 1, idleTimeoutMillis: 10000,
      ssl: local ? false : { rejectUnauthorized: false } });
    const wrap = (c) => async (sql, p = []) => { const r = await c.query(sql, p); return { rows: r.rows, count: r.rowCount }; };
    driver = {
      query: wrap(pool),
      async tx(fn) {
        const c = await pool.connect();
        try { await c.query('BEGIN'); const r = await fn(wrap(c)); await c.query('COMMIT'); return r; }
        catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
        finally { c.release(); }
      },
      close: () => pool.end()
    };
    if (process.env.AUTO_MIGRATE === '1') await driver.query(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  } else {
    const mod = '@electric-sql/pglite'; // اسم في متغير عشان Vercel ما يحاول يضمّه في الإنتاج
    const { PGlite } = await import(mod);
    const pg = new PGlite(process.env.PGLITE_DIR || undefined);
    await pg.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    const wrap = (c) => async (sql, p = []) => { const r = await c.query(sql, p); return { rows: r.rows, count: r.affectedRows ?? r.rows.length }; };
    driver = { query: wrap(pg), tx: (fn) => pg.transaction((t) => fn(wrap(t))), close: () => pg.close() };
  }
  return driver;
}

export const q = async (sql, p) => (await init()).query(sql, p);
export const one = async (sql, p) => (await q(sql, p)).rows[0] ?? null;
export const tx = async (fn) => (await init()).tx(async (run) => fn({
  q: run, one: async (sql, p) => (await run(sql, p)).rows[0] ?? null }));
export const closeDb = async () => { if (driver) await driver.close(); driver = null; };

// credit/debit لازم تتنادى جوه tx() وبياخدوا الـ t بتاعها
export async function credit(t, uid, amt, reason, ref) {
  await t.q('UPDATE users SET balance=balance+$1 WHERE id=$2', [amt, uid]);
  await t.q('INSERT INTO wallet_tx(user_id,delta,reason,ref) VALUES($1,$2,$3,$4)', [uid, amt, reason, ref ?? null]);
}
export async function debit(t, uid, amt, reason, ref) {
  const r = await t.q('UPDATE users SET balance=balance-$1 WHERE id=$2 AND balance>=$1', [amt, uid]);
  if (!r.count) throw new HttpError(402, 'رصيدك غير كافٍ');
  await t.q('INSERT INTO wallet_tx(user_id,delta,reason,ref) VALUES($1,$2,$3,$4)', [uid, -amt, reason, ref ?? null]);
}

// ---------- كلمات السر والجلسات ----------
export const hashPw = (pw) => { const s = randomBytes(16); return s.toString('hex') + ':' + scryptSync(pw, s, 64).toString('hex'); };
export const checkPw = (pw, st) => {
  const [s, h] = st.split(':');
  return timingSafeEqual(scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(h, 'hex'));
};
const sha = (t) => createHash('sha256').update(t).digest('hex');
export async function newSession(uid) {
  const t = randomBytes(32).toString('hex');
  await q("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [sha(t), uid]);
  return t;
}
export const dropSession = (t) => q('DELETE FROM sessions WHERE token_hash=$1', [sha(t || '')]);
export async function userByToken(t) {
  if (!t) return null;
  return one(`SELECT u.id,u.name,u.phone,u.role,u.grade,u.balance FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [sha(t)]);
}

// ---------- حد المحاولات (في الداتابيز عشان يشتغل مع أكتر من نسخة سيرفر) ----------
export async function limit(key, max, ms) {
  const r = await one(`INSERT INTO rate_limits(key,window_start,count) VALUES($1,now(),1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2::float8) THEN 1 ELSE rate_limits.count+1 END,
      window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2::float8) THEN now() ELSE rate_limits.window_start END
    RETURNING count`, [key, ms / 1000]);
  if (r.count > max) throw new HttpError(429, 'محاولات كتير، جرّب بعد شوية');
}
// تنضيف دوري خفيف
export async function cleanup() {
  await q('DELETE FROM sessions WHERE expires_at<now()');
  await q("DELETE FROM rate_limits WHERE window_start<now()-interval '1 day'");
}
