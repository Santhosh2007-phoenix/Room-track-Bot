-- Run this SQL in Supabase Dashboard > SQL Editor.
CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS floors (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS rooms (
  id BIGSERIAL PRIMARY KEY,
  floor_id BIGINT NOT NULL REFERENCES floors(id) ON DELETE RESTRICT,
  room_number TEXT NOT NULL,
  room_type TEXT NOT NULL DEFAULT 'Patient Room',
  status TEXT NOT NULL DEFAULT 'Available' CHECK (status IN ('Available','Occupied','Maintenance')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(floor_id, room_number)
);
CREATE TABLE IF NOT EXISTS patients (
  id BIGSERIAL PRIMARY KEY,
  patient_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  floor TEXT NOT NULL,
  room TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT 'General Medicine',
  age INTEGER,
  gender TEXT,
  admission_date DATE,
  contact_reference TEXT,
  status TEXT NOT NULL DEFAULT 'Admitted' CHECK (status IN ('Admitted','Discharged','Transferred')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_patients_name_lower ON patients (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_patients_room ON patients (floor, room);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ip_address TEXT,
  last_sync TIMESTAMPTZ,
  patients_synced INTEGER NOT NULL DEFAULT 0,
  connected BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS dispatch_queue (
  id BIGSERIAL PRIMARY KEY,
  patient_id TEXT NOT NULL,
  name TEXT NOT NULL,
  floor TEXT NOT NULL,
  room TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS search_history (
  id BIGSERIAL PRIMARY KEY,
  searched_name TEXT NOT NULL,
  result TEXT NOT NULL,
  floor TEXT,
  room TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO device_status(id) VALUES (1) ON CONFLICT (id) DO NOTHING;
INSERT INTO floors(name,label) VALUES
 ('1F','Floor 1'),('2F','Floor 2'),('3F','Floor 3'),('4F','Floor 4')
ON CONFLICT (name) DO NOTHING;
INSERT INTO rooms(floor_id,room_number,room_type,status)
SELECT f.id, v.room_number, v.room_type, 'Available'
FROM (VALUES
 ('1F','101','Service Room'),('1F','102','Service Room'),('1F','103','Patient Room'),('1F','104','Patient Room'),
 ('2F','201','Patient Room'),('2F','202','Patient Room'),('2F','203','Patient Room'),('2F','204','Patient Room'),
 ('3F','301','Patient Room'),('3F','302','Patient Room'),('3F','303','Patient Room'),('3F','304','Patient Room'),
 ('4F','401','Patient Room'),('4F','402','Patient Room'),('4F','403','Patient Room'),('4F','404','Patient Room')
) AS v(floor_name,room_number,room_type)
JOIN floors f ON f.name=v.floor_name
ON CONFLICT (floor_id,room_number) DO NOTHING;
INSERT INTO patients(patient_id,name,floor,room,department,status,admission_date) VALUES
 ('P001','JOHN','2F','201','General Medicine','Admitted',CURRENT_DATE),
 ('P002','SARA','2F','202','Cardiology','Admitted',CURRENT_DATE),
 ('P003','RAJ','2F','203','Orthopedics','Admitted',CURRENT_DATE),
 ('P004','MEENA','2F','204','General Medicine','Admitted',CURRENT_DATE),
 ('P005','KUMAR','3F','301','Neurology','Admitted',CURRENT_DATE),
 ('P006','ANITA','3F','302','Cardiology','Admitted',CURRENT_DATE),
 ('P007','X-RAY','1F','102','Radiology','Admitted',CURRENT_DATE),
 ('P008','DR VENKATESH','1F','103','General Medicine','Admitted',CURRENT_DATE),
 ('P009','MEDICAL','1F','101','Service','Admitted',CURRENT_DATE)
ON CONFLICT (patient_id) DO NOTHING;
INSERT INTO settings(key,value) VALUES
 ('hospital_name','Room Track Hospital'),('bot_name','Room Track Bot'),('esp32_api_url','http://192.168.1.20:4000/api'),('admin_username','admin')
ON CONFLICT (key) DO NOTHING;
-- Demo admin is created by server-postgres.js from ADMIN_USERNAME / ADMIN_PASSWORD on startup.
