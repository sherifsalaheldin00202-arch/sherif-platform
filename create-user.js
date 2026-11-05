// الاستخدام: npm run create-user -- teacher 01012345678 "كلمة_سر_قوية_١٠+" "اسم المستر"
// لازم DATABASE_URL يكون في .env (رابط Supabase)
import { q, hashPw, closeDb } from './db.js';
const [role, phone, pw, ...n] = process.argv.slice(2);
if (!['teacher', 'supervisor'].includes(role) || !/^01[0125]\d{8}$/.test(phone || '') || !pw || pw.length < 10 || !n.length) {
  console.error('npm run create-user -- <teacher|supervisor> <01xxxxxxxxx> <password(10+)> <name>'); process.exit(1);
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL مش متضبط: الحساب هيتعمل في قاعدة محلية مؤقتة وهيضيع.'); process.exit(1); }
try {
  await q('INSERT INTO users(name,phone,pass_hash,role) VALUES($1,$2,$3,$4)', [n.join(' '), phone, hashPw(pw), role]);
  console.log('تم إنشاء', role);
} catch (e) { console.error(e.code === '23505' ? 'الرقم ده مسجّل بالفعل' : e.message); process.exitCode = 1; }
await closeDb();
