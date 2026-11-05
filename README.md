# منصة تعليمية: Vercel + Supabase

الدفع: **فودافون كاش / إنستا باي (يدوي)** أو **أكواد تفعيل** فقط. مفيش دفع أونلاين.

## تجربة محلية (من غير أي حساب)
```
npm install
npm test        # 8 اختبارات على Postgres محلي
npm run dev     # http://localhost:3000 (قاعدة محلية مؤقتة، بتتمسح مع كل تشغيل)
```
اختياري: `TEST_DATABASE_URL=postgresql://... npm test` لتجربة الاختبارات على Postgres حقيقي (قاعدة فاضية).

## 1) Supabase (مجاني)
1. أنشئ مشروع على supabase.com.
2. SQL Editor > New query > الصق محتوى `schema.sql` > Run. (بينشئ الجداول ويفعّل RLS لقفل الوصول العام.)
3. Project Settings > Database > Connection string > **Transaction pooler** (بورت 6543) وانسخ الرابط. ده `DATABASE_URL`.
4. ماتستخدمش مفتاح `anon` ولا `service_role` في أي حتة. السيرفر بيتصل بالرابط ده بس.

## 2) إنشاء حساب المستر والمشرف
```
cp .env.example .env     # املا DATABASE_URL
npm run create-user -- teacher 01012345678 "كلمة_سر_قوية_١٠+" "اسم المستر"
npm run create-user -- supervisor 01012345679 "كلمة_سر_قوية_١٠+" "اسم المشرف"
```

## 3) Vercel
1. ارفع المجلد على GitHub (ملف `.env` متحطش في GitHub، `.gitignore` بيمنعه).
2. Vercel > Add New Project > اختار الريبو. Framework: Other. سيب Build Command فاضي.
3. Settings > Environment Variables: `DATABASE_URL` و`VODAFONE_CASH_NUMBER` و`INSTAPAY_HANDLE`.
4. Deploy. افتح `https://مشروعك.vercel.app/api/payment-info` بعد تسجيل الدخول للتأكد إن الـ API شغال.

**اتأكد في أول نشر:** `vercel.json` (outputDirectory + rewrites) متكتب من التوثيق ومااتجرّبش على Vercel. لو `/` أو `/api/...` رجعت 404، ابعتلي رسالة الخطأ.

## الـ API
| المسار | الصلاحية |
|---|---|
| `POST /api/auth/register` · `login` · `logout` · `GET /api/me` | عام / مسجّل |
| `GET /api/courses` · `POST /api/courses/:id/buy` · `POST /api/codes/redeem` | طالب |
| `GET /api/payment-info` | مسجّل |
| `POST /api/charge-requests` · `GET /api/charge-requests` (طلباتي) | طالب |
| `GET /api/teacher/charge-requests` · `POST .../:id/approve` أو `reject` | مستر / مشرف |
| `POST /api/teacher/courses` · `/:id/publish` · `POST /api/teacher/codes` | مستر |
| `GET /api/teacher/courses` · `GET /api/teacher/codes` (غير المستخدمة) · `GET /api/teacher/students` · `GET /api/teacher/stats` | مستر |
| `POST /api/teacher/courses/:id/update` · `/:id/delete` (ممنوع لو عليه مشتركين) · `GET/POST /api/teacher/courses/:id/lessons` · `POST /api/teacher/lessons/:id/delete` · `GET /api/teacher/students/:id` (تقرير الطالب) | مستر |

المبالغ بالقروش في الـ DB والردود (١ جنيه = ١٠٠). الطلبات بتستقبل جنيهات.

## الأمان
scrypt لكلمات السر · جلسات HttpOnly + SameSite=Lax (Secure على https) · حد محاولات محفوظ في الداتابيز · أكواد عشوائية ٧٥ بت وتتفعّل مرة واحدة · الرصيد بيتعدّل جوه transactions ومش بينزل تحت صفر · مراجعة طلب الشحن مرة واحدة بس · RLS مفعّل على كل الجداول.

## لسه ناقص
ربط الصفحات بالـ API (الخطوة 2) · حماية الفيديو · الامتحانات · تقارير الأهالي.
