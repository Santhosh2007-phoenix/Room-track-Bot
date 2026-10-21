import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { body, query, validationResult } from 'express-validator';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage() });

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for Supabase PostgreSQL mode.');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
  keepAlive: true
});
pool.on('error', (err) => {
  console.warn('[PG-POOL] Non-fatal idle connection error:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.warn('[Process] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.warn('[Process] Uncaught Exception:', err.message);
});
const app = express();
const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET;
const API_KEY = process.env.API_KEY;
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('Set JWT_SECRET to a random secret of at least 32 characters.');
if (!API_KEY || API_KEY.length < 24) throw new Error('Set API_KEY to a random device key of at least 24 characters.');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',') : true }));
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => { console.log(`[REQ] ${req.method} ${req.url} from ${req.ip}`); next(); });
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false }));

// Auto-Discovery UDP beacon on Port 4001 for ESP32
try {
  const udpDiscovery = dgram.createSocket('udp4');
  udpDiscovery.on('message', (msg, rinfo) => {
    if (msg.toString().includes('DISCOVER_ROOM_TRACK_BOT')) {
      const ack = Buffer.from(`RTB_SERVER_ACK:${PORT}`);
      udpDiscovery.send(ack, rinfo.port, rinfo.address, (err) => {
        if (!err) console.log(`[Auto-Discovery] Replied to ESP32 at ${rinfo.address}:${rinfo.port}`);
      });
    }
  });
  udpDiscovery.on('error', (err) => {
    console.warn('[Auto-Discovery] UDP error (non-fatal):', err.message);
  });
  udpDiscovery.bind(4001, '0.0.0.0', () => {
    console.log('[Auto-Discovery] UDP beacon listening on port 4001');
  });
} catch (e) {
  console.warn('[Auto-Discovery] Failed to start UDP beacon:', e.message);
}

const q = (text, params=[]) => pool.query(text, params);
const validate = (req,res,next) => { const errors=validationResult(req); if(!errors.isEmpty()) return res.status(400).json({error:'Validation failed',details:errors.array()}); next(); };
const asyncRoute = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next);
const publicPatient = p => ({id:p.patient_id,name:p.name,floor:p.floor,room:p.room,father_name:p.father_name||'',city:p.city||''});
const adminOnly = asyncRoute(async(req,res,next)=>{
  const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  if(!token) return res.status(401).json({error:'Authentication required'});
  try { req.admin=jwt.verify(token,JWT_SECRET); const r=await q('SELECT id,username FROM admins WHERE id=$1',[req.admin.id]); if(!r.rowCount)return res.status(401).json({error:'Authentication required'}); req.admin=r.rows[0]; next(); }
  catch { return res.status(401).json({error:'Invalid or expired session'}); }
});
const deviceOnly=(req,res,next)=>{ const supplied=req.get('x-api-key')||''; const a=Buffer.from(supplied); const b=Buffer.from(API_KEY); if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return res.status(401).json({success:false,message:'Unauthorized device'}); next(); };
const refreshRooms = async()=>q(`UPDATE rooms r SET status=CASE WHEN r.status='Maintenance' THEN 'Maintenance' WHEN EXISTS(SELECT 1 FROM patients p JOIN floors f ON f.name=p.floor WHERE p.room=r.room_number AND f.id=r.floor_id AND p.status='Admitted' AND p.deleted_at IS NULL) THEN 'Occupied' ELSE 'Available' END`);
const getPatient = async id => (await q('SELECT * FROM patients WHERE id=$1 AND deleted_at IS NULL',[id])).rows[0];
const listPatients = async({search='',floor='',room='',department='',status='',limit=1000,offset=0}={})=>{
 let sql="SELECT id,COALESCE(patient_id,patient_code) AS patient_id,COALESCE(name,patient_name) AS name,floor,room,COALESCE(father_name,'') AS father_name,COALESCE(city,'') AS city,department,age,gender,admission_date,contact_reference,status,notes,created_at,updated_at,deleted_at FROM patients WHERE deleted_at IS NULL"; const a=[]; const add=(clause,val)=>{a.push(val);sql+=clause.replace('?',`$${a.length}`)};
 if(search.trim()){a.push(`%${search.trim()}%`); const n=a.length; sql+=` AND (COALESCE(name,patient_name) ILIKE $${n} OR COALESCE(patient_id,patient_code) ILIKE $${n} OR room ILIKE $${n} OR floor ILIKE $${n} OR COALESCE(father_name,'') ILIKE $${n} OR COALESCE(city,'') ILIKE $${n})`;}
 for(const [key,val] of [['floor',floor],['room',room],['department',department],['status',status]]) if(val)add(` AND ${key}=?`,val);
 a.push(limit);sql+=` ORDER BY created_at DESC LIMIT $${a.length}`;a.push(offset);sql+=` OFFSET $${a.length}`;
 return (await q(sql,a)).rows;
};
app.get('/api/health',(req,res)=>res.json({ok:true,service:'Room Track Bot API',database:'supabase-postgresql'}));
app.post('/api/auth/login',[body('username').trim().notEmpty(),body('password').isString().notEmpty()],validate,asyncRoute(async(req,res)=>{
 const r=await q('SELECT * FROM admins WHERE LOWER(username)=LOWER($1)',[req.body.username]);const admin=r.rows[0];
 if(!admin || !(await bcrypt.compare(req.body.password,admin.password_hash)))return res.status(401).json({error:'Invalid username or password'});
 const token=jwt.sign({id:admin.id,username:admin.username},JWT_SECRET,{expiresIn:'30d'});res.json({token,user:{id:admin.id,username:admin.username}});
}));
app.get('/api/auth/me',adminOnly,(req,res)=>res.json({user:req.admin}));
// Public visitor routes return only name, floor and room.
app.get('/api/visitor/search',rateLimit({windowMs:60000,limit:40}),asyncRoute(async(req,res)=>{
 const name=String(req.query.name||'').replace(/\0/g,'').trim().replace(/\s+/g,' ');if(!name||name.length>100)return res.status(400).json({success:false,message:'Enter a valid patient name'});
 const r=await q("SELECT id,COALESCE(patient_id,patient_code) AS patient_id,COALESCE(name,patient_name) AS name,floor,room,room_id,COALESCE(father_name,'') AS father_name,COALESCE(city,'') AS city FROM patients WHERE (LOWER(COALESCE(name,patient_name))=LOWER($1) OR LOWER(COALESCE(patient_id,patient_code))=LOWER($1)) AND status='Admitted' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 10",[name]);
 const rows=r.rows;const p=rows[0];
 await q('INSERT INTO search_history(searched_name,result,floor,room,searched_at) VALUES($1,$2,$3,$4,NOW())',[name,p?'FOUND':'NOT FOUND',p?.floor||null,p?.room||null]);
 if(!p)return res.json({success:true,found:false,message:'Patient not found'});
 res.json({success:true,found:true,count:rows.length,patients:rows.map(publicPatient),patient:publicPatient(p)});
}));
app.post('/api/visitor/dispatch',rateLimit({windowMs:60000,limit:30}),asyncRoute(async(req,res)=>{
 const id=String(req.body?.id||'').trim();if(!id||id.length>100)return res.status(400).json({success:false,message:'Select a patient first'});
 const r=await q("SELECT id,COALESCE(patient_id,patient_code) AS patient_id,COALESCE(name,patient_name) AS name,floor,room,room_id,COALESCE(father_name,'') AS father_name,COALESCE(city,'') AS city FROM patients WHERE (LOWER(COALESCE(patient_id,patient_code))=LOWER($1) OR id::text=$1) AND status='Admitted' AND deleted_at IS NULL",[id]);const p=r.rows[0];
 if(!p)return res.status(404).json({success:false,message:'Patient is no longer available. Please search again.'});
 await q('INSERT INTO dispatch_queue(patient_id,name,floor,room,father_name,city) VALUES($1,$2,$3,$4,$5,$6)',[p.patient_id,p.name,p.floor,p.room,p.father_name,p.city]);
 try{await q('INSERT INTO announcement_queue(patient_id,name,floor,room,room_id,status) VALUES($1,$2,$3,$4,$5,$6)',[p.patient_id,p.name,p.floor,p.room,p.room_id||null,'PENDING']);}catch(_){}
 res.json({success:true,message:'Patient location sent to Room Track Bot'});
}));
app.get('/api/device/next-patient',deviceOnly,asyncRoute(async(req,res)=>{
 const client=await pool.connect();try{await client.query('BEGIN');const r=await client.query('SELECT * FROM dispatch_queue WHERE delivered_at IS NULL ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED');const item=r.rows[0];if(!item){await client.query('COMMIT');return res.json({success:true,pending:false});}await client.query('UPDATE dispatch_queue SET delivered_at=NOW() WHERE id=$1',[item.id]);try{await client.query("UPDATE announcement_queue SET status='DELIVERED',delivered_at=NOW() WHERE patient_id=$1 AND status='PENDING'",[item.patient_id]);}catch(_){}await client.query('COMMIT');res.json({success:true,pending:true,patient:{id:item.patient_id,name:item.name,floor:item.floor,room:item.room,father_name:item.father_name||'',city:item.city||''}});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
app.post('/api/device/heartbeat',deviceOnly,asyncRoute(async(req,res)=>{const ip=String(req.body?.ip_address||req.ip||'').slice(0,80);const n=Number((await q("SELECT COUNT(*)::int AS n FROM patients WHERE status='Admitted' AND deleted_at IS NULL")).rows[0].n);await q('UPDATE device_status SET connected=TRUE,ip_address=$1,last_sync=NOW(),patients_synced=$2 WHERE id=1',[ip,n]);res.json({ok:true,patients_synced:n});}));

app.post('/api/device/voice-search', deviceOnly, upload.single('audio'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

  // Fallback API keys: users can set these in .env
  const STT_API_KEY = process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY;
  if (!STT_API_KEY) return res.status(500).json({ error: 'STT API key (GROQ_API_KEY or OPENAI_API_KEY) not configured in .env' });

  try {
    const isGroq = !!process.env.GROQ_API_KEY;
    const apiUrl = isGroq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
    
    // Create FormData for the file upload (using native fetch)
    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' });
    formData.append('file', blob, 'audio.wav');
    formData.append('model', isGroq ? 'whisper-large-v3' : 'whisper-1');
    formData.append('language', 'en');
    formData.append('response_format', 'json');

    const sttRes = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${STT_API_KEY}` },
      body: formData
    });

    if (!sttRes.ok) {
      console.error('[Voice Search] API Error:', await sttRes.text());
      return res.status(500).json({ error: 'Failed to transcribe audio' });
    }

    const { text } = await sttRes.json();
    const transcribedName = (text || '').replace(/\0/g, '').replace(/[^a-zA-Z0-9 ]/g, '').trim();

    // Log the search
    const logSearch = async (found, id, floor, room) => {
      await q(`INSERT INTO search_history(searched_name, result, floor, room, created_at) VALUES($1, $2, $3, $4, NOW())`, [transcribedName, found ? 'FOUND' : 'NOT FOUND', floor, room]);
    };

    if (!transcribedName) {
      return res.json({ success: false, transcribed_name: '', message: 'Could not understand audio' });
    }

    // Search patient in database
    const result = await q(
      `SELECT name, floor, room FROM patients WHERE name ILIKE $1 AND status='Admitted' AND deleted_at IS NULL LIMIT 1`, 
      [`%${transcribedName}%`]
    );

    if (result.rowCount === 0) {
      await logSearch(false, null, null, null);
      return res.json({ success: false, transcribed_name: transcribedName, message: 'Patient not found' });
    }

    const patient = result.rows[0];
    await logSearch(true, null, patient.floor, patient.room);
    
    // Return result to ESP32 so it can trigger DFPlayer Mini
    res.json({
      success: true,
      transcribed_name: transcribedName,
      patient: {
        name: patient.name,
        floor: patient.floor,
        room: patient.room
      }
    });

  } catch (err) {
    console.error('[Voice Search] Error:', err);
    res.status(500).json({ error: 'Internal server error processing voice' });
  }
}));
app.get('/api/search-history',adminOnly,asyncRoute(async(req,res)=>{const period=String(req.query.period||'');let where='';if(period==='today')where='WHERE created_at >= CURRENT_DATE';else if(period==='week')where="WHERE created_at >= NOW()-INTERVAL '7 days'";else if(period==='month')where="WHERE created_at >= NOW()-INTERVAL '30 days'";res.json((await q(`SELECT id,searched_name,result,floor,room,created_at FROM search_history ${where} ORDER BY id DESC LIMIT 200`)).rows);}));
app.use('/api/patients',adminOnly);
app.get('/api/patients',asyncRoute(async(req,res)=>{const page=Math.max(1,Number(req.query.page)||1),pageSize=Math.min(100,Math.max(1,Number(req.query.pageSize)||20));const filters={search:String(req.query.search||''),floor:String(req.query.floor||''),room:String(req.query.room||''),department:String(req.query.department||''),status:String(req.query.status||''),limit:pageSize,offset:(page-1)*pageSize};const items=await listPatients(filters);let sql='SELECT COUNT(*)::int AS n FROM patients WHERE deleted_at IS NULL';const a=[];if(filters.search.trim()){a.push(`%${filters.search.trim()}%`);const n=a.length;sql+=` AND (name ILIKE $${n} OR patient_id ILIKE $${n} OR room ILIKE $${n} OR floor ILIKE $${n})`;}for(const [k,v] of [['floor',filters.floor],['room',filters.room],['department',filters.department],['status',filters.status]])if(v){a.push(v);sql+=` AND ${k}=$${a.length}`;}const total=Number((await q(sql,a)).rows[0].n);res.json({items,total,page,pageSize});}));
app.get('/api/patients/search',asyncRoute(async(req,res)=>res.json(await listPatients({search:String(req.query.name||req.query.q||''),limit:100}))));
app.get('/api/patients/:id',asyncRoute(async(req,res)=>{const p=await getPatient(req.params.id);if(!p)return res.status(404).json({error:'Patient not found'});res.json(p);}));
const patientValidators=[body('patient_id').trim().isLength({min:2,max:30}),body('name').trim().isLength({min:1,max:100}),body('floor').trim().isLength({min:1,max:20}),body('room').trim().isLength({min:1,max:20}),body('father_name').optional({nullable:true}).trim().isLength({max:100}),body('city').optional({nullable:true}).trim().isLength({max:100}),body('department').optional({nullable:true}).trim().isLength({max:100}),body('age').optional({nullable:true,checkFalsy:true}).isInt({min:0,max:130}).toInt(),body('gender').optional({nullable:true}).isString().isLength({max:30}),body('admission_date').optional({nullable:true}).isISO8601(),body('status').optional().isIn(['Admitted','Discharged','Transferred']),body('notes').optional({nullable:true}).isString().isLength({max:2000})];
const patientValues=b=>[b.patient_id.trim(),b.patient_id.trim(),b.name.trim(),b.name.trim(),b.floor.trim(),b.room.trim(),(b.father_name||'').trim(),(b.city||'').trim(),(b.department||'General Medicine').trim(),b.age??null,b.gender||null,b.admission_date||null,b.contact_reference||null,b.status||'Admitted',b.notes||''];
app.post('/api/patients',patientValidators,validate,asyncRoute(async(req,res)=>{const b=req.body;try{const r=await q(`INSERT INTO patients(patient_id,patient_code,name,patient_name,floor,room,father_name,city,department,age,gender,admission_date,contact_reference,status,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,patientValues(b));await refreshRooms();res.status(201).json(r.rows[0]);}catch(e){if(e.code==='23505')return res.status(409).json({error:'Patient ID already exists'});throw e;}}));
app.put('/api/patients/:id',patientValidators,validate,asyncRoute(async(req,res)=>{const b=req.body;try{const r=await q(`UPDATE patients SET patient_id=$1,patient_code=$2,name=$3,patient_name=$4,floor=$5,room=$6,father_name=$7,city=$8,department=$9,age=$10,gender=$11,admission_date=$12,contact_reference=$13,status=$14,notes=$15,updated_at=NOW() WHERE id=$16 AND deleted_at IS NULL RETURNING *`,[...patientValues(b),req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Patient not found'});await refreshRooms();res.json(r.rows[0]);}catch(e){if(e.code==='23505')return res.status(409).json({error:'Patient ID already exists'});throw e;}}));
app.delete('/api/patients/:id',asyncRoute(async(req,res)=>{const r=await q('UPDATE patients SET deleted_at=NOW(),updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Patient not found'});await refreshRooms();res.json({message:'Patient archived successfully'});}));
app.get('/api/rooms',adminOnly,asyncRoute(async(req,res)=>res.json((await q('SELECT r.*,f.name AS floor FROM rooms r JOIN floors f ON f.id=r.floor_id ORDER BY f.name,r.room_number')).rows)));
app.post('/api/rooms',adminOnly,[body('floor_id').isInt({min:1}).toInt(),body('room_number').trim().notEmpty().isLength({max:20}),body('room_type').optional().isString().isLength({max:60}),body('status').optional().isIn(['Available','Occupied','Maintenance'])],validate,asyncRoute(async(req,res)=>{try{const r=await q('INSERT INTO rooms(floor_id,room_number,room_type,status) VALUES($1,$2,$3,$4) RETURNING *',[req.body.floor_id,req.body.room_number.trim(),req.body.room_type||'Patient Room',req.body.status||'Available']);res.status(201).json(r.rows[0]);}catch(e){if(e.code==='23505')return res.status(409).json({error:'Room already exists on this floor'});throw e;}}));
app.put('/api/rooms/:id',adminOnly,[body('floor_id').isInt({min:1}).toInt(),body('room_number').trim().notEmpty().isLength({max:20}),body('room_type').optional().isString().isLength({max:60}),body('status').isIn(['Available','Occupied','Maintenance'])],validate,asyncRoute(async(req,res)=>{try{const r=await q('UPDATE rooms SET floor_id=$1,room_number=$2,room_type=$3,status=$4 WHERE id=$5 RETURNING *',[req.body.floor_id,req.body.room_number.trim(),req.body.room_type||'Patient Room',req.body.status,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Room not found'});res.json(r.rows[0]);}catch(e){if(e.code==='23505')return res.status(409).json({error:'Room already exists on this floor'});throw e;}}));
app.delete('/api/rooms/:id',adminOnly,asyncRoute(async(req,res)=>{const r=await q('SELECT r.*,f.name AS floor FROM rooms r JOIN floors f ON f.id=r.floor_id WHERE r.id=$1',[req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Room not found'});const x=r.rows[0];const has=await q("SELECT 1 FROM patients WHERE floor=$1 AND room=$2 AND status='Admitted' AND deleted_at IS NULL",[x.floor,x.room_number]);if(has.rowCount)return res.status(409).json({error:'Cannot delete a room with an admitted patient'});await q('DELETE FROM rooms WHERE id=$1',[req.params.id]);res.json({message:'Room deleted'});}));
app.get('/api/floors',adminOnly,asyncRoute(async(req,res)=>res.json((await q('SELECT f.*,COUNT(DISTINCT r.id)::int AS room_count FROM floors f LEFT JOIN rooms r ON r.floor_id=f.id GROUP BY f.id ORDER BY f.name')).rows)));
app.post('/api/floors',adminOnly,[body('name').trim().isLength({min:1,max:20}),body('label').optional().isString().isLength({max:80})],validate,asyncRoute(async(req,res)=>{try{const r=await q('INSERT INTO floors(name,label) VALUES($1,$2) RETURNING *',[req.body.name.trim(),req.body.label||'']);res.status(201).json(r.rows[0]);}catch(e){if(e.code==='23505')return res.status(409).json({error:'Floor already exists'});throw e;}}));
app.put('/api/floors/:id',adminOnly,[body('name').trim().isLength({min:1,max:20}),body('label').optional().isString().isLength({max:80})],validate,asyncRoute(async(req,res)=>{const client=await pool.connect();try{await client.query('BEGIN');const old=await client.query('SELECT * FROM floors WHERE id=$1 FOR UPDATE',[req.params.id]);if(!old.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Floor not found'});}const name=req.body.name.trim();const r=await client.query('UPDATE floors SET name=$1,label=$2 WHERE id=$3 RETURNING *',[name,req.body.label||'',req.params.id]);if(old.rows[0].name!==name)await client.query("UPDATE patients SET floor=$1,updated_at=NOW() WHERE floor=$2 AND deleted_at IS NULL",[name,old.rows[0].name]);await client.query('COMMIT');res.json(r.rows[0]);}catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'Floor already exists'});throw e;}finally{client.release();}}));
app.delete('/api/floors/:id',adminOnly,asyncRoute(async(req,res)=>{const f=await q('SELECT * FROM floors WHERE id=$1',[req.params.id]);if(!f.rowCount)return res.status(404).json({error:'Floor not found'});const rooms=await q('SELECT COUNT(*)::int AS n FROM rooms WHERE floor_id=$1',[req.params.id]);if(rooms.rows[0].n)return res.status(409).json({error:'Delete or move this floor’s rooms first'});const p=await q('SELECT 1 FROM patients WHERE floor=$1 AND deleted_at IS NULL LIMIT 1',[f.rows[0].name]);if(p.rowCount)return res.status(409).json({error:'Move or remove patient records on this floor first'});await q('DELETE FROM floors WHERE id=$1',[req.params.id]);res.json({message:'Floor deleted'});}));
app.get('/api/dashboard/stats',adminOnly,asyncRoute(async(req,res)=>{await refreshRooms();const n=async sql=>Number((await q(sql)).rows[0].n);const [patients,active,rooms,occupied,available,maintenance,floors,recent]=await Promise.all([n('SELECT COUNT(*)::int n FROM patients WHERE deleted_at IS NULL'),n("SELECT COUNT(*)::int n FROM patients WHERE status='Admitted' AND deleted_at IS NULL"),n('SELECT COUNT(*)::int n FROM rooms'),n("SELECT COUNT(*)::int n FROM rooms WHERE status='Occupied'"),n("SELECT COUNT(*)::int n FROM rooms WHERE status='Available'"),n("SELECT COUNT(*)::int n FROM rooms WHERE status='Maintenance'"),n('SELECT COUNT(*)::int n FROM floors'),q('SELECT * FROM patients WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 5')]);res.json({patients,active,rooms,occupied,available,maintenance,floors,recent:recent.rows});}));
app.get('/api/reports',adminOnly,asyncRoute(async(req,res)=>{await refreshRooms();const n=async sql=>Number((await q(sql)).rows[0].n);const [totalPatients,admitted,discharged,transferred,occupancy,floorCounts]=await Promise.all([n('SELECT COUNT(*)::int n FROM patients WHERE deleted_at IS NULL'),n("SELECT COUNT(*)::int n FROM patients WHERE status='Admitted' AND deleted_at IS NULL"),n("SELECT COUNT(*)::int n FROM patients WHERE status='Discharged' AND deleted_at IS NULL"),n("SELECT COUNT(*)::int n FROM patients WHERE status='Transferred' AND deleted_at IS NULL"),q('SELECT status,COUNT(*)::int AS count FROM rooms GROUP BY status'),q("SELECT floor,COUNT(*)::int AS count FROM patients WHERE status='Admitted' AND deleted_at IS NULL GROUP BY floor ORDER BY floor")]);res.json({totalPatients,admitted,discharged,transferred,occupancy:occupancy.rows,floorCounts:floorCounts.rows});}));
app.get('/api/esp32/status',adminOnly,asyncRoute(async(req,res)=>{const s=(await q('SELECT * FROM device_status WHERE id=1')).rows[0]||{};res.json({...s,connected:!!s.last_sync&&(Date.now()-new Date(s.last_sync).getTime()<60000)});}));
app.post('/api/esp32/heartbeat',adminOnly,asyncRoute(async(req,res)=>{const ip=String(req.body?.ip_address||'').slice(0,80);const n=Number((await q("SELECT COUNT(*)::int n FROM patients WHERE status='Admitted' AND deleted_at IS NULL")).rows[0].n);await q('UPDATE device_status SET connected=TRUE,ip_address=$1,last_sync=NOW(),patients_synced=$2 WHERE id=1',[ip,n]);res.json({ok:true,patients_synced:n});}));
app.get('/api/settings',adminOnly,asyncRoute(async(req,res)=>{const rows=(await q('SELECT key,value FROM settings')).rows;res.json(Object.fromEntries(rows.map(x=>[x.key,x.value])));}));
app.put('/api/settings',adminOnly,asyncRoute(async(req,res)=>{const b=req.body;if(b.new_password){const a=(await q('SELECT * FROM admins WHERE id=$1',[req.admin.id])).rows[0];if(!b.current_password||!(await bcrypt.compare(b.current_password,a.password_hash)))return res.status(400).json({error:'Current password is incorrect'});await q('UPDATE admins SET password_hash=$1 WHERE id=$2',[await bcrypt.hash(b.new_password,12),req.admin.id]);}if(b.admin_username&&b.admin_username!==req.admin.username){try{await q('UPDATE admins SET username=$1 WHERE id=$2',[b.admin_username,req.admin.id]);await q("INSERT INTO settings(key,value) VALUES('admin_username',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[b.admin_username]);}catch(e){if(e.code==='23505')return res.status(409).json({error:'Username already exists'});throw e;}}for(const k of ['hospital_name','bot_name','esp32_api_url'])if(b[k]!==undefined)await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[k,String(b[k])]);res.json({message:'Settings saved'});}));
app.use((req,res)=>res.status(404).json({error:'Endpoint not found'}));
app.use((err,req,res,next)=>{console.error('API error:',err.message);if(res.headersSent)return next(err);res.status(500).json({error:'Internal server error'});});
async function bootstrap(){
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await q("INSERT INTO device_status(id) VALUES(1) ON CONFLICT(id) DO NOTHING");
      const username=process.env.ADMIN_USERNAME||'admin';const password=process.env.ADMIN_PASSWORD||'admin123';
      const existing=await q('SELECT id FROM admins WHERE LOWER(username)=LOWER($1)',[username]);if(!existing.rowCount)await q('INSERT INTO admins(username,password_hash) VALUES($1,$2)',[username,await bcrypt.hash(password,12)]);
      await q("INSERT INTO settings(key,value) VALUES('hospital_name','Room Track Hospital'),('bot_name','Room Track Bot'),('admin_username',$1) ON CONFLICT(key) DO NOTHING",[username]);
      await q('SELECT 1');
      app.listen(PORT,'0.0.0.0',()=>console.log(`Room Track Bot API (Supabase PostgreSQL) running on port ${PORT}`));
      return;
    } catch (err) {
      console.warn(`[Bootstrap] Attempt ${attempt}/5 failed: ${err.message}. Retrying in 2s...`);
      if (attempt === 5) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
bootstrap().catch(err=>{console.error('Startup failed:',err.message);process.exit(1);});
 process.on('SIGTERM',async()=>{await pool.end();process.exit(0)});
 
 export default app;
