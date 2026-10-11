
-- Reference schema; backend/db.js creates these tables automatically.
CREATE TABLE admins(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);
CREATE TABLE floors(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, label TEXT);
CREATE TABLE rooms(id INTEGER PRIMARY KEY AUTOINCREMENT, floor_id INTEGER NOT NULL REFERENCES floors(id), room_number TEXT NOT NULL, room_type TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(floor_id,room_number));
CREATE TABLE patients(id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, floor TEXT NOT NULL, room TEXT NOT NULL, department TEXT NOT NULL, age INTEGER, gender TEXT, admission_date TEXT, contact_reference TEXT, status TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
