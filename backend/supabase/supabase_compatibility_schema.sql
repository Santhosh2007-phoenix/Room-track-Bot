-- ============================================================================
-- ROOM TRACK BOT - Supabase Complete Migration & Compatibility Schema
-- Project: https://eepqkyjzfnzjqjwnshxf.supabase.co
-- Compatible with: backend/server-postgres.js & backend/server.js
-- ============================================================================

-- 1. FLOORS TABLE (Create if not exists)
CREATE TABLE IF NOT EXISTS floors (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. ROOMS TABLE (Align with rooms and add floor_number/status/room_type compatibility)
CREATE TABLE IF NOT EXISTS rooms (
  id BIGSERIAL PRIMARY KEY,
  room_number TEXT NOT NULL,
  floor_number INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure rooms table has all needed columns for server-postgres
ALTER TABLE rooms ALTER COLUMN room_number TYPE TEXT USING room_number::TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor_id BIGINT REFERENCES floors(id) ON DELETE SET NULL;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS room_type TEXT NOT NULL DEFAULT 'Patient Room';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Available';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 3. PATIENTS TABLE (Align with existing patients table: patient_code, patient_name, room_id)
CREATE TABLE IF NOT EXISTS patients (
  id BIGSERIAL PRIMARY KEY,
  patient_code TEXT UNIQUE,
  patient_name TEXT,
  room_id BIGINT REFERENCES rooms(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add standard fields used by the express backend and UI
ALTER TABLE patients ADD COLUMN IF NOT EXISTS patient_id TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS floor TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS room TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS department TEXT NOT NULL DEFAULT 'General Medicine';
ALTER TABLE patients ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS admission_date DATE DEFAULT CURRENT_DATE;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS contact_reference TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Admitted';
ALTER TABLE patients ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
ALTER TABLE patients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Sync helper: Keep name & patient_id synchronized with patient_name & patient_code
CREATE OR REPLACE FUNCTION sync_patient_columns()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.patient_code IS NULL AND NEW.patient_id IS NOT NULL THEN
    NEW.patient_code := NEW.patient_id;
  END IF;
  IF NEW.patient_id IS NULL AND NEW.patient_code IS NOT NULL THEN
    NEW.patient_id := NEW.patient_code;
  END IF;
  IF NEW.patient_name IS NULL AND NEW.name IS NOT NULL THEN
    NEW.patient_name := NEW.name;
  END IF;
  IF NEW.name IS NULL AND NEW.patient_name IS NOT NULL THEN
    NEW.name := NEW.patient_name;
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_patients ON patients;
CREATE TRIGGER trg_sync_patients
BEFORE INSERT OR UPDATE ON patients
FOR EACH ROW EXECUTE FUNCTION sync_patient_columns();

-- 4. SEARCH HISTORY TABLE
CREATE TABLE IF NOT EXISTS search_history (
  id BIGSERIAL PRIMARY KEY,
  searched_name TEXT NOT NULL,
  searched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE search_history ADD COLUMN IF NOT EXISTS result TEXT DEFAULT 'NOT FOUND';
ALTER TABLE search_history ADD COLUMN IF NOT EXISTS floor TEXT;
ALTER TABLE search_history ADD COLUMN IF NOT EXISTS room TEXT;
ALTER TABLE search_history ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 5. ANNOUNCEMENT QUEUE TABLE
CREATE TABLE IF NOT EXISTS announcement_queue (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT REFERENCES rooms(id),
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE announcement_queue ADD COLUMN IF NOT EXISTS patient_id TEXT;
ALTER TABLE announcement_queue ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE announcement_queue ADD COLUMN IF NOT EXISTS floor TEXT;
ALTER TABLE announcement_queue ADD COLUMN IF NOT EXISTS room TEXT;
ALTER TABLE announcement_queue ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

-- 6. ADMINS TABLE
CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. SETTINGS TABLE
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 8. DEVICE STATUS TABLE
CREATE TABLE IF NOT EXISTS device_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ip_address TEXT,
  last_sync TIMESTAMPTZ,
  patients_synced INTEGER NOT NULL DEFAULT 0,
  connected BOOLEAN NOT NULL DEFAULT FALSE
);

-- 9. DISPATCH QUEUE TABLE (Used by ESP32 next-patient delivery)
CREATE TABLE IF NOT EXISTS dispatch_queue (
  id BIGSERIAL PRIMARY KEY,
  patient_id TEXT NOT NULL,
  name TEXT NOT NULL,
  floor TEXT NOT NULL,
  room TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

-- 10. INDEXES FOR PERFORMANCE & SEARCH
CREATE INDEX IF NOT EXISTS idx_patients_name_lower ON patients (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_patients_patient_code ON patients (LOWER(patient_code));
CREATE INDEX IF NOT EXISTS idx_patients_room ON patients (floor, room);
CREATE INDEX IF NOT EXISTS idx_search_history_created ON search_history (created_at DESC);

-- 11. ENABLE ROW LEVEL SECURITY (RLS) POLICIES
-- Allow public anon read for visitor search, but full access via backend connection pool or authenticated admin
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE floors ENABLE ROW LEVEL SECURITY;
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_queue ENABLE ROW LEVEL SECURITY;

-- Read policies for public tables (anon key can read active patients, rooms, floors)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow public read patients') THEN
    CREATE POLICY "Allow public read patients" ON patients FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow public read rooms') THEN
    CREATE POLICY "Allow public read rooms" ON rooms FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow public read floors') THEN
    CREATE POLICY "Allow public read floors" ON floors FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow public insert search_history') THEN
    CREATE POLICY "Allow public insert search_history" ON search_history FOR INSERT WITH CHECK (true);
  END IF;
END $$;

-- 12. INITIAL SEED DATA (Floors & Rooms & Demo Admin)
INSERT INTO device_status(id) VALUES (1) ON CONFLICT (id) DO NOTHING;

INSERT INTO floors(name, label) VALUES
  ('1F', 'Floor 1'),
  ('2F', 'Floor 2'),
  ('3F', 'Floor 3'),
  ('4F', 'Floor 4')
ON CONFLICT (name) DO NOTHING;

-- Seed default rooms linked to floors
INSERT INTO rooms(room_number, floor_number, floor_id, room_type, status)
SELECT v.room_number, v.floor_num, f.id, v.room_type, 'Available'
FROM (VALUES
  ('101', 1, '1F', 'Service Room'),
  ('102', 1, '1F', 'Service Room'),
  ('103', 1, '1F', 'Patient Room'),
  ('104', 1, '1F', 'Patient Room'),
  ('201', 2, '2F', 'Patient Room'),
  ('202', 2, '2F', 'Patient Room'),
  ('203', 2, '2F', 'Patient Room'),
  ('204', 2, '2F', 'Patient Room'),
  ('301', 3, '3F', 'Patient Room'),
  ('302', 3, '3F', 'Patient Room'),
  ('303', 3, '3F', 'Patient Room'),
  ('304', 3, '3F', 'Patient Room'),
  ('401', 4, '4F', 'Patient Room'),
  ('402', 4, '4F', 'Patient Room'),
  ('403', 4, '4F', 'Patient Room'),
  ('404', 4, '4F', 'Patient Room')
) AS v(room_number, floor_num, floor_name, room_type)
JOIN floors f ON f.name = v.floor_name
ON CONFLICT DO NOTHING;

-- Seed demo patients
INSERT INTO patients(patient_code, patient_id, patient_name, name, floor, room, department, status, admission_date)
VALUES
  ('P001', 'P001', 'JOHN', 'JOHN', '2F', '201', 'General Medicine', 'Admitted', CURRENT_DATE),
  ('P002', 'P002', 'SARA', 'SARA', '2F', '202', 'Cardiology', 'Admitted', CURRENT_DATE),
  ('P003', 'P003', 'RAJ', 'RAJ', '2F', '203', 'Orthopedics', 'Admitted', CURRENT_DATE),
  ('P004', 'P004', 'MEENA', 'MEENA', '2F', '204', 'General Medicine', 'Admitted', CURRENT_DATE),
  ('P005', 'P005', 'KUMAR', 'KUMAR', '3F', '301', 'Neurology', 'Admitted', CURRENT_DATE),
  ('P006', 'P006', 'ANITA', 'ANITA', '3F', '302', 'Cardiology', 'Admitted', CURRENT_DATE),
  ('P007', 'P007', 'X-RAY', 'X-RAY', '1F', '102', 'Radiology', 'Admitted', CURRENT_DATE),
  ('P008', 'P008', 'DR VENKATESH', 'DR VENKATESH', '1F', '103', 'General Medicine', 'Admitted', CURRENT_DATE),
  ('P009', 'P009', 'MEDICAL', 'MEDICAL', '1F', '101', 'Service', 'Admitted', CURRENT_DATE)
ON CONFLICT (patient_code) DO NOTHING;

-- Seed settings
INSERT INTO settings(key, value) VALUES
  ('hospital_name', 'Room Track Hospital'),
  ('bot_name', 'Room Track Bot'),
  ('esp32_api_url', 'http://192.168.1.20:4000/api'),
  ('admin_username', 'admin')
ON CONFLICT (key) DO NOTHING;
