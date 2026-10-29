# ryhathon26-quantrox
**RYHATHON 2026 Grand Finale · QUANTROX (RYH26-C25B1B)**

---

# ROOM TRACK BOT
Patient Database & Room Management System

This merged package preserves the original frontend UI and ESP32 sketch from `room-track-bot-updated.zip` and adds a Supabase PostgreSQL backend option. The frontend files are unchanged.

A full-stack starter application with React + TypeScript + Tailwind, Express REST API, SQLite, JWT admin authentication, and ESP32 Arduino integration.

## Architecture

Admin browser → React frontend → Express API → SQLite database → ESP32 over Wi-Fi HTTP.

Visitors enter patient names directly on the web page at `/visitor`. The backend searches the live SQLite database and queues the selected location; the ESP32 polls that queue over Wi-Fi. Patient data is not hard-coded into firmware, so changes do not require re-uploading the sketch.

## Requirements
- Node.js 20+
- npm
- Arduino IDE 2.x for hardware firmware
- ESP32 board package and libraries listed in `esp32/RoomTrackBot.ino`

## 1. Start the backend
```bash
cd backend
cp .env.example .env
npm install
npm run dev
```
Backend runs at `http://localhost:4000`. SQLite is created automatically at `backend/database/room-track-bot.sqlite`. Sample floors, rooms, patients, and a demo admin are seeded on first run.

Demo login: `admin` / `admin123`. Change the demo password before using this on a real network.

## 2. Start the frontend
In another terminal:
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```
Open the Vite URL shown in the terminal. The frontend API base defaults to `http://localhost:4000/api`.

## 3. ESP32 configuration
Edit the Wi-Fi name/password and API base URL near the top of `esp32/RoomTrackBot.ino`.
- `API_BASE` must be reachable from the ESP32, for example `http://192.168.1.20:4000/api`.
- Your laptop/server and ESP32 must be on the same Wi-Fi network, or the server must be reachable over a properly secured network.
- Do not use `http://192.168.4.1` unless the backend actually runs at that address. `192.168.4.1` is commonly an ESP32 soft-AP address, not automatically the web server.
- The firmware uses Wi-Fi HTTP only. Do not use a Bluetooth Terminal for visitor input; open the website `/visitor` on a phone/tablet connected to the same network. The ESP32 polls `/api/device/next-patient` with `X-API-Key`.
- LCD: I2C 16x2 (commonly address `0x27`); DFPlayer Mini on Serial2; IR sensor on configured pin. Confirm pins and logic against your actual wiring before powering the circuit.

Install Arduino libraries:
- ArduinoJson (v7 compatible)
- LiquidCrystal_I2C
- DFRobotDFPlayerMini
ESP32 built-in: WiFi, HTTPClient, BluetoothSerial.

## API overview
Admin endpoints require `Authorization: Bearer <token>`:
- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET/POST /api/patients`
- `GET/PUT/DELETE /api/patients/:id`
- `GET /api/patients/search?name=John` (admin list/search)
- `GET /api/rooms`, `POST /api/rooms`, `PUT/DELETE /api/rooms/:id`
- `GET /api/floors`, `POST /api/floors`, `PUT/DELETE /api/floors/:id`
- `GET /api/dashboard/stats`
- `GET /api/reports`
- `GET/PUT /api/settings`
- `GET /api/esp32/status`, `POST /api/esp32/heartbeat`

Visitor endpoints (minimal public response):
- `GET /api/visitor/search?name=John` — exact case-insensitive search; returns only patient ID, name, floor and room
- `POST /api/visitor/dispatch` with `{ "id": "P001" }` — queues the currently valid location for the bot

ESP32 endpoints (require `X-API-Key`):
- `GET /api/device/next-patient` — receives the next queued patient location once
- `POST /api/device/heartbeat` — device heartbeat

The device endpoints are intentionally read-only. In a production hospital deployment, add TLS, network segmentation, device authentication/API keys, audit logging, backups, and a formal privacy/security review. This demo uses HTTP on a local network and is not a certified clinical system.

## Example
```bash
curl "http://localhost:4000/api/visitor/search?name=jOhN"
```
Found:
```json
{"success":true,"found":true,"patient":{"id":"P001","name":"JOHN","floor":"2F","room":"201"}}
```
Not found:
```json
{"success":true,"found":false,"message":"Patient not found"}
```

## Important behavior
- Search is case-insensitive and trims extra whitespace.
- Discharged/transferred patients remain in the admin database but are not returned by ESP32 device search.
- Patient IDs are unique.
- Deleting a patient removes it from future device lookups.
- Room occupancy and dashboard statistics are computed from the database.
- The demo login credentials are for development only.

## Visitor and ESP32 flow
1. Start backend and frontend, then open `http://localhost:5173/visitor`.
2. Search a patient name; only name, floor and room are displayed.
3. Press **SEND TO ROOM TRACK BOT**. The backend validates the current admitted record and adds it to a queue.
4. ESP32 polls the queue every 1.5 seconds over Wi-Fi and receives the selected location.
5. Configure `API_KEY` in `backend/.env` and the same value in `esp32/RoomTrackBot.ino`. Use a strong unique key.
6. Set `API_BASE` to the server computer's LAN IP, not `localhost`, then configure Wi-Fi credentials.
7. DFPlayer audio clips are modular examples; prepare and test the listed numbered clips on an SD card. The firmware announces floor and room digits in English first, then Tamil, and does not speak the patient name.

**Demo warning:** This is a learning prototype, not a production-certified hospital system. Use HTTPS, strong authentication, a device-specific token, network isolation, access logging, backups, and a privacy/security review before real patient data is used. The demo admin password must be changed.

## 4. Use Supabase PostgreSQL (online database)

This project now includes a PostgreSQL backend mode. The same React frontend and REST API routes can use Supabase PostgreSQL instead of the local SQLite file. Start only one backend mode at a time on port 4000.

1. Create a project at https://supabase.com/.
2. In Supabase, open **SQL Editor → New query**. Copy the full contents of `backend/supabase/schema.sql`, run it, and check that the tables and demo patient rows were created.
3. Open **Project Settings → Database → Connection string** and copy the PostgreSQL URI. Use the Session Pooler URI if your deployment platform does not support Supabase's direct IPv6 connection. URL-encode special characters in the database password.
4. In `backend`, copy `.env.supabase.example` to `.env` and set `DATABASE_URL`, `JWT_SECRET`, `API_KEY`, `FRONTEND_ORIGIN`, and a new `ADMIN_PASSWORD`. Do not commit `.env` to GitHub.
5. Install dependencies with `npm install`, then run `npm run dev:supabase`. This starts `server-postgres.js` and uses Supabase PostgreSQL; it does not read or write the SQLite file.
6. Start the frontend as usual (`cd frontend`, `npm install`, `npm run dev`). It calls `http://localhost:4000/api` by default, so no frontend code change is needed for local testing.
7. Confirm `http://localhost:4000/api/health` returns `"database":"supabase-postgresql"`, then test the visitor page with `john` and `JOHN`.

### Supabase notes
- Keep the Supabase database connection string and database password only in the backend `.env`. Never put `DATABASE_URL` or a database password in `frontend/.env`.
- The frontend communicates with Express; the Express backend communicates with Supabase PostgreSQL. The browser does not connect directly to the database.
- The schema is in `backend/supabase/schema.sql`; it creates tables and demo floors, rooms, and patients. The backend creates the demo admin account on first startup using `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
- Existing local SQLite records are not automatically copied to Supabase. If you already entered real/demo records into SQLite, export and import them separately before switching.
- Supabase free-tier limits and connection availability can change. Do not use this prototype for real patient data until a qualified review covers authentication, authorization, TLS, audit trails, backups, retention, and applicable privacy rules.

### Supabase backend scripts
```bash
cd backend
npm install
npm run dev:supabase
# production process:
npm run start:supabase
```
