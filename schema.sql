-- شغّل الملف ده مرة واحدة في Supabase: SQL Editor > New query > الصق > Run
-- المبالغ كلها بالقروش (١ جنيه = ١٠٠) كأعداد صحيحة.

CREATE TABLE IF NOT EXISTS users(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('student','teacher','supervisor')),
  grade INTEGER,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL);

CREATE TABLE IF NOT EXISTS courses(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  grade INTEGER NOT NULL,
  price INTEGER NOT NULL CHECK(price>=0),
  published BOOLEAN NOT NULL DEFAULT false);

CREATE TABLE IF NOT EXISTS enrollments(
  user_id INTEGER NOT NULL REFERENCES users(id),
  course_id INTEGER NOT NULL REFERENCES courses(id),
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,course_id));

CREATE TABLE IF NOT EXISTS codes(
  code TEXT PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  used_by INTEGER REFERENCES users(id),
  used_at TIMESTAMPTZ);

CREATE TABLE IF NOT EXISTS wallet_tx(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS charge_requests(
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK(amount>0),
  method TEXT NOT NULL CHECK(method IN('vodafone_cash','instapay')),
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- حدّ المحاولات (بدل الذاكرة، لأن Vercel بتشغّل أكتر من نسخة)
CREATE TABLE IF NOT EXISTS rate_limits(
  key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_tx(user_id);
CREATE INDEX IF NOT EXISTS idx_charge_status ON charge_requests(status);

-- مهم أمنيًا: Supabase بتعرض جداول public عبر API عام بمفتاح anon.
-- تفعيل RLS من غير أي policy يقفل الوصول ده تمامًا. السيرفر بتاعنا بيتصل بصلاحية postgres فمش متأثر.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_tx ENABLE ROW LEVEL SECURITY;
ALTER TABLE charge_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
