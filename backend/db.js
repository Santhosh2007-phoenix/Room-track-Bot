
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, 'database');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'room-track-bot.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS floors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  floor_id INTEGER NOT NULL REFERENCES floors(id) ON DELETE RESTRICT,
  room_number TEXT NOT NULL,
  room_type TEXT NOT NULL DEFAULT 'Patient Room',
  status TEXT NOT NULL DEFAULT 'Available' CHECK(status IN ('Available','Occupied','Maintenance')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(floor_id, room_number)
);
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  floor TEXT NOT NULL,
  room TEXT NOT NULL,
  department TEXT NOT NULL DEFAULT 'General Medicine',
  age INTEGER,
  gender TEXT,
  admission_date TEXT,
  contact_reference TEXT,
  status TEXT NOT NULL DEFAULT 'Admitted' CHECK(status IN ('Admitted','Discharged','Transferred')),
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_patients_room ON patients(room);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS device_status (
  id INTEGER PRIMARY KEY CHECK(id=1),
  ip_address TEXT,
  last_sync TEXT,
  patients_synced INTEGER NOT NULL DEFAULT 0,
  connected INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS dispatch_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id TEXT NOT NULL,
  name TEXT NOT NULL,
  floor TEXT NOT NULL,
  room TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT
);
CREATE TABLE IF NOT EXISTS search_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  searched_name TEXT NOT NULL,
  result TEXT NOT NULL,
  floor TEXT,
  room TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO device_status(id, connected, patients_synced) VALUES(1,0,0);
`);

const adminCount = db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;
if (!adminCount) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT INTO admins(username,password_hash) VALUES(?,?)')
    .run(username, bcrypt.hashSync(password, 12));
}
const floorCount = db.prepare('SELECT COUNT(*) AS n FROM floors').get().n;
if (!floorCount) {
  const insertFloor = db.prepare('INSERT INTO floors(name,label) VALUES(?,?)');
  ['1F','2F','3F','4F'].forEach(f => insertFloor.run(f, `Floor ${f[0]}`));
}
const floorId = name => db.prepare('SELECT id FROM floors WHERE name=?').get(name)?.id;
const roomCount = db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n;
if (!roomCount) {
  const insertRoom = db.prepare('INSERT OR IGNORE INTO rooms(floor_id,room_number,room_type,status) VALUES(?,?,?,?)');
  for (const [floor, nums] of [['1F',['101','102','103','104']],['2F',['201','202','203','204']],['3F',['301','302','303','304']],['4F',['401','402','403','404']]]) {
    nums.forEach((num, i) => insertRoom.run(floorId(floor), num, i===0?'Service Room':'Patient Room', 'Available'));
  }
  db.prepare("UPDATE rooms SET room_type='Service Room' WHERE room_number IN ('101','102')").run();
}
const patientCount = db.prepare('SELECT COUNT(*) AS n FROM patients').get().n;
if (!patientCount) {
  const insert = db.prepare(`INSERT INTO patients(patient_id,name,floor,room,department,status,admission_date)
    VALUES(?,?,?,?,?,'Admitted',date('now'))`);
  [
    ['P001','JOHN','2F','201','General Medicine'],
    ['P002','SARA','2F','202','Cardiology'],
    ['P003','RAJ','2F','203','Orthopedics'],
    ['P004','MEENA','2F','204','General Medicine'],
    ['P005','KUMAR','3F','301','Neurology'],
    ['P006','ANITA','3F','302','Cardiology'],
    ['P007','X-RAY','1F','102','Radiology'],
    ['P008','DR VENKATESH','1F','103','General Medicine'],
    ['P009','MEDICAL','1F','101','Service']
  ].forEach(p => insert.run(...p));
}
const settingDefaults = [
  ['hospital_name','Room Track Hospital'],
  ['bot_name','Room Track Bot'],
  ['esp32_api_url','http://192.168.1.20:4000/api'],
  ['admin_username', process.env.ADMIN_USERNAME || 'admin']
];
const settingInsert = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
settingDefaults.forEach(s => settingInsert.run(...s));

export default db;
