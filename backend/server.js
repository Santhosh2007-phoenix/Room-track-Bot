
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { body, param, query, validationResult } from 'express-validator';
import db from './db.js';
import { requireAuth } from './middleware.js';

const app = express();
const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-change-me';
if (JWT_SECRET === 'development-only-change-me') console.warn('WARNING: set a strong JWT_SECRET in .env before deployment.');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',') : true }));
app.use(express.json({ limit: '100kb' }));
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, limit: 20, standardHeaders: true, legacyHeaders: false }));

const validate = (req,res,next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
};
const patientFields = [
  body('patient_id').trim().isLength({min:2,max:30}).withMessage('Patient ID must be 2–30 characters'),
  body('name').trim().isLength({min:1,max:100}).withMessage('Name is required'),
  body('floor').trim().isLength({min:1,max:20}),
  body('room').trim().isLength({min:1,max:20}),
  body('department').optional({nullable:true}).trim().isLength({max:100}),
  body('age').optional({nullable:true,checkFalsy:true}).isInt({min:0,max:130}).toInt(),
  body('gender').optional({nullable:true}).isString().isLength({max:30}),
  body('admission_date').optional({nullable:true}).isISO8601(),
  body('status').optional().isIn(['Admitted','Discharged','Transferred']),
  body('notes').optional({nullable:true}).isString().isLength({max:2000}),
];
const publicPatient = p => ({
  id:p.patient_id, name:p.name, floor:p.floor, room:p.room,
  department:p.department, status:p.status
});
const getPatient = id => db.prepare('SELECT * FROM patients WHERE id=?').get(id);
const listPatients = ({search='',floor='',room='',department='',status='',limit=1000,offset=0}={}) => {
  let sql = 'SELECT * FROM patients WHERE 1=1'; const args=[];
  if (search.trim()) { sql += " AND (name LIKE ? COLLATE NOCASE OR patient_id LIKE ? COLLATE NOCASE OR room LIKE ? COLLATE NOCASE OR floor LIKE ? COLLATE NOCASE)"; const s=`%${search.trim()}%`; args.push(s,s,s,s); }
  if (floor) { sql += ' AND floor=?'; args.push(floor); }
  if (room) { sql += ' AND room=?'; args.push(room); }
  if (department) { sql += ' AND department=?'; args.push(department); }
  if (status) { sql += ' AND status=?'; args.push(status); }
  sql += ' ORDER BY datetime(created_at) DESC LIMIT ? OFFSET ?'; args.push(limit,offset);
  return db.prepare(sql).all(...args);
};
const refreshRoomStatuses = () => {
  db.prepare(`UPDATE rooms SET status = CASE
    WHEN status='Maintenance' THEN 'Maintenance'
    WHEN EXISTS(SELECT 1 FROM patients p JOIN floors f ON f.name=p.floor
      WHERE p.room=rooms.room_number AND f.id=rooms.floor_id AND p.status='Admitted') THEN 'Occupied'
    ELSE 'Available' END`).run();
};


const deviceAuthorized = (req,res,next) => {
  const expected = process.env.API_KEY || 'development-device-key-change-me';
  if (!req.get('x-api-key') || req.get('x-api-key') !== expected) return res.status(401).json({success:false,message:'Unauthorized device'});
  next();
};

// Public visitor endpoints return only name, floor and room.
app.get('/api/visitor/search', rateLimit({windowMs:60000,limit:40}), (req,res) => {
  const name=String(req.query.name||'').trim().replace(/\s+/g,' ');
  if(!name || name.length>100) return res.status(400).json({success:false,message:'Enter a valid patient name'});
  const p=db.prepare("SELECT patient_id,name,floor,room FROM patients WHERE name=? COLLATE NOCASE AND status='Admitted' LIMIT 1").get(name);
  db.prepare('INSERT INTO search_history(searched_name,result,floor,room) VALUES(?,?,?,?)').run(name,p?'FOUND':'NOT FOUND',p?.floor||null,p?.room||null);
  if(!p) return res.json({success:true,found:false,message:'Patient not found'});
  res.json({success:true,found:true,patient:{id:p.patient_id,name:p.name,floor:p.floor,room:p.room}});
});
app.post('/api/visitor/dispatch', rateLimit({windowMs:60000,limit:30}), (req,res) => {
  const id=String(req.body?.id||'').trim();
  if(!id || id.length>30) return res.status(400).json({success:false,message:'Select a patient first'});
  const p=db.prepare("SELECT patient_id,name,floor,room FROM patients WHERE patient_id=? COLLATE NOCASE AND status='Admitted'").get(id);
  if(!p) return res.status(404).json({success:false,message:'Patient is no longer available. Please search again.'});
  db.prepare('INSERT INTO dispatch_queue(patient_id,name,floor,room) VALUES(?,?,?,?)').run(p.patient_id,p.name,p.floor,p.room);
  res.json({success:true,message:'Patient location sent to Room Track Bot'});
});
app.get('/api/device/next-patient', deviceAuthorized, (req,res) => {
  const item=db.prepare('SELECT * FROM dispatch_queue WHERE delivered_at IS NULL ORDER BY id ASC LIMIT 1').get();
  if(!item) return res.json({success:true,pending:false});
  db.prepare("UPDATE dispatch_queue SET delivered_at=datetime('now') WHERE id=?").run(item.id);
  res.json({success:true,pending:true,patient:{id:item.patient_id,name:item.name,floor:item.floor,room:item.room}});
});
app.get('/api/search-history', requireAuth, (req,res) => {
  const period=String(req.query.period||'');
  const where=period==='today'?"WHERE date(created_at)=date('now','localtime')":period==='week'?"WHERE created_at >= datetime('now','-7 days')":period==='month'?"WHERE created_at >= datetime('now','-30 days')":'';
  res.json(db.prepare(`SELECT id,searched_name,result,floor,room,created_at FROM search_history ${where} ORDER BY id DESC LIMIT 200`).all());
});

app.get('/api/health', (req,res)=>res.json({ok:true,service:'Room Track Bot API'}));

app.post('/api/auth/login', [
  body('username').trim().notEmpty(), body('password').isString().notEmpty()
], validate, (req,res) => {
  const admin = db.prepare('SELECT * FROM admins WHERE username=?').get(req.body.username);
  if (!admin || !bcrypt.compareSync(req.body.password, admin.password_hash))
    return res.status(401).json({error:'Invalid username or password'});
  const token = jwt.sign({id:admin.id,username:admin.username}, JWT_SECRET, {expiresIn:'8h'});
  res.json({token,user:{id:admin.id,username:admin.username}});
});
app.get('/api/auth/me', requireAuth, (req,res)=>res.json({user:req.admin}));

// ESP32 read-only routes: admitted patients only.
app.get('/api/device/patients', (req,res) => {
  const rows = db.prepare("SELECT patient_id,name,floor,room,department,status FROM patients WHERE status='Admitted' ORDER BY name COLLATE NOCASE").all();
  db.prepare('UPDATE device_status SET last_sync=datetime(\'now\'),patients_synced=?,connected=1 WHERE id=1').run(rows.length);
  res.json(rows.map(publicPatient));
});
app.get('/api/device/search', [
  query('name').trim().isLength({min:1,max:100})
], validate, (req,res) => {
  const p = db.prepare("SELECT * FROM patients WHERE name=? COLLATE NOCASE AND status='Admitted' LIMIT 1").get(req.query.name.trim());
  if (!p) return res.json({found:false});
  db.prepare("UPDATE device_status SET last_sync=datetime('now'),connected=1 WHERE id=1").run();
  res.json({found:true,patient:publicPatient(p)});
});
app.post('/api/device/heartbeat', (req,res) => {
  const ip = String(req.body?.ip_address || req.ip || '').slice(0,80);
  const n = db.prepare("SELECT COUNT(*) AS n FROM patients WHERE status='Admitted'").get().n;
  db.prepare("UPDATE device_status SET connected=1,ip_address=?,last_sync=datetime('now'),patients_synced=? WHERE id=1").run(ip,n);
  res.json({ok:true,patients_synced:n});
});

// Protected admin API
app.use('/api/patients', requireAuth);
app.get('/api/patients', (req,res) => {
  const page=Math.max(1,Number(req.query.page)||1), pageSize=Math.min(100,Math.max(1,Number(req.query.pageSize)||20));
  const filters={search:String(req.query.search||''),floor:String(req.query.floor||''),room:String(req.query.room||''),department:String(req.query.department||''),status:String(req.query.status||''),limit:pageSize,offset:(page-1)*pageSize};
  const items=listPatients(filters);
  let countSql='SELECT COUNT(*) AS n FROM patients WHERE 1=1'; const args=[];
  if(filters.search.trim()){countSql+=" AND (name LIKE ? COLLATE NOCASE OR patient_id LIKE ? COLLATE NOCASE OR room LIKE ? COLLATE NOCASE OR floor LIKE ? COLLATE NOCASE)";const s=`%${filters.search.trim()}%`;args.push(s,s,s,s);}
  for(const k of ['floor','room','department','status']) if(filters[k]){countSql+=` AND ${k}=?`;args.push(filters[k]);}
  res.json({items,total:db.prepare(countSql).get(...args).n,page,pageSize});
});
app.get('/api/patients/search', (req,res) => {
  const term=String(req.query.name||req.query.q||'').trim();
  res.json(listPatients({search:term,limit:100}));
});
app.get('/api/patients/:id', (req,res) => {
  const p=getPatient(req.params.id); if(!p)return res.status(404).json({error:'Patient not found'}); res.json(p);
});
app.post('/api/patients', patientFields, validate, (req,res) => {
  const b=req.body;
  try {
    const result=db.prepare(`INSERT INTO patients(patient_id,name,floor,room,department,age,gender,admission_date,contact_reference,status,notes)
      VALUES(@patient_id,@name,@floor,@room,@department,@age,@gender,@admission_date,@contact_reference,@status,@notes)`).run({
      patient_id:b.patient_id.trim(),name:b.name.trim(),floor:b.floor.trim(),room:b.room.trim(),
      department:(b.department||'General Medicine').trim(),age:b.age??null,gender:b.gender||null,
      admission_date:b.admission_date||null,contact_reference:b.contact_reference||null,status:b.status||'Admitted',notes:b.notes||''
    });
    refreshRoomStatuses(); res.status(201).json(getPatient(result.lastInsertRowid));
  } catch(e) { if(String(e.code).includes('UNIQUE')) return res.status(409).json({error:'Patient ID already exists'}); throw e; }
});
app.put('/api/patients/:id', patientFields, validate, (req,res) => {
  if(!getPatient(req.params.id))return res.status(404).json({error:'Patient not found'});
  const b=req.body;
  try {
    db.prepare(`UPDATE patients SET patient_id=@patient_id,name=@name,floor=@floor,room=@room,department=@department,age=@age,
      gender=@gender,admission_date=@admission_date,contact_reference=@contact_reference,status=@status,notes=@notes,updated_at=datetime('now') WHERE id=@id`).run({
      id:req.params.id,patient_id:b.patient_id.trim(),name:b.name.trim(),floor:b.floor.trim(),room:b.room.trim(),
      department:(b.department||'General Medicine').trim(),age:b.age??null,gender:b.gender||null,
      admission_date:b.admission_date||null,contact_reference:b.contact_reference||null,status:b.status||'Admitted',notes:b.notes||''
    });
    refreshRoomStatuses();res.json(getPatient(req.params.id));
  } catch(e){if(String(e.code).includes('UNIQUE'))return res.status(409).json({error:'Patient ID already exists'});throw e;}
});
app.delete('/api/patients/:id', (req,res) => {
  const p=getPatient(req.params.id);if(!p)return res.status(404).json({error:'Patient not found'});
  db.prepare('DELETE FROM patients WHERE id=?').run(req.params.id);refreshRoomStatuses();res.json({message:'Patient removed successfully'});
});

app.get('/api/rooms', requireAuth, (req,res) => res.json(db.prepare(`SELECT r.*,f.name AS floor FROM rooms r JOIN floors f ON f.id=r.floor_id ORDER BY f.name,r.room_number`).all()));
app.post('/api/rooms', requireAuth, [
  body('floor_id').isInt({min:1}).toInt(),body('room_number').trim().notEmpty().isLength({max:20}),
  body('room_type').optional().isString().isLength({max:60}),body('status').optional().isIn(['Available','Occupied','Maintenance'])
], validate, (req,res) => {
  try{const r=db.prepare('INSERT INTO rooms(floor_id,room_number,room_type,status) VALUES(?,?,?,?)').run(req.body.floor_id,req.body.room_number.trim(),req.body.room_type||'Patient Room',req.body.status||'Available');res.status(201).json(db.prepare('SELECT r.*,f.name AS floor FROM rooms r JOIN floors f ON f.id=r.floor_id WHERE r.id=?').get(r.lastInsertRowid));}
  catch(e){if(String(e.code).includes('UNIQUE'))return res.status(409).json({error:'Room already exists on this floor'});throw e;}
});
app.put('/api/rooms/:id', requireAuth, [
  body('floor_id').isInt({min:1}).toInt(),body('room_number').trim().notEmpty().isLength({max:20}),
  body('room_type').optional().isString().isLength({max:60}),body('status').isIn(['Available','Occupied','Maintenance'])
], validate, (req,res) => {
  const exists=db.prepare('SELECT id FROM rooms WHERE id=?').get(req.params.id);if(!exists)return res.status(404).json({error:'Room not found'});
  try{db.prepare('UPDATE rooms SET floor_id=?,room_number=?,room_type=?,status=? WHERE id=?').run(req.body.floor_id,req.body.room_number.trim(),req.body.room_type||'Patient Room',req.body.status,req.params.id);res.json(db.prepare('SELECT r.*,f.name AS floor FROM rooms r JOIN floors f ON f.id=r.floor_id WHERE r.id=?').get(req.params.id));}
  catch(e){if(String(e.code).includes('UNIQUE'))return res.status(409).json({error:'Room already exists on this floor'});throw e;}
});
app.delete('/api/rooms/:id', requireAuth, (req,res) => {
  const r=db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);if(!r)return res.status(404).json({error:'Room not found'});
  const floor=db.prepare('SELECT name FROM floors WHERE id=?').get(r.floor_id)?.name;
  const has=db.prepare("SELECT 1 FROM patients WHERE floor=? AND room=? AND status='Admitted'").get(floor,r.room_number);
  if(has)return res.status(409).json({error:'Cannot delete a room with an admitted patient'});
  db.prepare('DELETE FROM rooms WHERE id=?').run(req.params.id);res.json({message:'Room deleted'});
});

app.get('/api/floors', requireAuth, (req,res)=>res.json(db.prepare('SELECT f.*,COUNT(DISTINCT r.id) AS room_count FROM floors f LEFT JOIN rooms r ON r.floor_id=f.id GROUP BY f.id ORDER BY f.name').all()));
app.post('/api/floors', requireAuth, [body('name').trim().isLength({min:1,max:20}),body('label').optional().isString().isLength({max:80})], validate, (req,res)=>{
  try{const r=db.prepare('INSERT INTO floors(name,label) VALUES(?,?)').run(req.body.name.trim(),req.body.label||'');res.status(201).json(db.prepare('SELECT * FROM floors WHERE id=?').get(r.lastInsertRowid));}
  catch(e){if(String(e.code).includes('UNIQUE'))return res.status(409).json({error:'Floor already exists'});throw e;}
});
app.put('/api/floors/:id', requireAuth, [body('name').trim().isLength({min:1,max:20}),body('label').optional().isString().isLength({max:80})], validate, (req,res)=>{
  const f=db.prepare('SELECT * FROM floors WHERE id=?').get(req.params.id);if(!f)return res.status(404).json({error:'Floor not found'});
  const oldName=f.name,newName=req.body.name.trim();
  try{db.transaction(()=>{db.prepare('UPDATE floors SET name=?,label=? WHERE id=?').run(newName,req.body.label||'',req.params.id);if(oldName!==newName)db.prepare('UPDATE patients SET floor=?,updated_at=datetime(\'now\') WHERE floor=?').run(newName,oldName);})();res.json(db.prepare('SELECT * FROM floors WHERE id=?').get(req.params.id));}
  catch(e){if(String(e.code).includes('UNIQUE'))return res.status(409).json({error:'Floor already exists'});throw e;}
});
app.delete('/api/floors/:id', requireAuth, (req,res)=>{
  const f=db.prepare('SELECT * FROM floors WHERE id=?').get(req.params.id);if(!f)return res.status(404).json({error:'Floor not found'});
  const count=db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE floor_id=?').get(req.params.id).n;
  if(count)return res.status(409).json({error:'Delete or move this floor’s rooms first'});
  if(db.prepare('SELECT 1 FROM patients WHERE floor=? LIMIT 1').get(f.name))return res.status(409).json({error:'Move or remove patient records on this floor first'});
  db.prepare('DELETE FROM floors WHERE id=?').run(req.params.id);res.json({message:'Floor deleted'});
});

app.get('/api/dashboard/stats', requireAuth, (req,res)=>{
  refreshRoomStatuses();
  const patients=db.prepare('SELECT COUNT(*) n FROM patients').get().n;
  const active=db.prepare("SELECT COUNT(*) n FROM patients WHERE status='Admitted'").get().n;
  const rooms=db.prepare('SELECT COUNT(*) n FROM rooms').get().n;
  const occupied=db.prepare("SELECT COUNT(*) n FROM rooms WHERE status='Occupied'").get().n;
  const available=db.prepare("SELECT COUNT(*) n FROM rooms WHERE status='Available'").get().n;
  const maintenance=db.prepare("SELECT COUNT(*) n FROM rooms WHERE status='Maintenance'").get().n;
  const floors=db.prepare('SELECT COUNT(*) n FROM floors').get().n;
  const recent=db.prepare('SELECT * FROM patients ORDER BY datetime(created_at) DESC LIMIT 5').all();
  res.json({patients,active,rooms,occupied,available,maintenance,floors,recent});
});
app.get('/api/reports', requireAuth, (req,res)=>{
  refreshRoomStatuses();
  res.json({
    totalPatients:db.prepare('SELECT COUNT(*) n FROM patients').get().n,
    admitted:db.prepare("SELECT COUNT(*) n FROM patients WHERE status='Admitted'").get().n,
    discharged:db.prepare("SELECT COUNT(*) n FROM patients WHERE status='Discharged'").get().n,
    transferred:db.prepare("SELECT COUNT(*) n FROM patients WHERE status='Transferred'").get().n,
    occupancy:db.prepare("SELECT status,COUNT(*) AS count FROM rooms GROUP BY status").all(),
    floorCounts:db.prepare("SELECT floor,COUNT(*) AS count FROM patients WHERE status='Admitted' GROUP BY floor ORDER BY floor").all()
  });
});
app.get('/api/esp32/status', requireAuth, (req,res)=>{
  const s=db.prepare('SELECT * FROM device_status WHERE id=1').get();
  // Mark stale after 60 seconds.
  const connected=!!s.last_sync && (Date.now()-new Date(s.last_sync.replace(' ','T')+'Z').getTime())<60000;
  res.json({...s,connected});
});
app.post('/api/esp32/heartbeat', requireAuth, (req,res)=>{
  const ip=String(req.body?.ip_address||'').slice(0,80);
  const n=db.prepare("SELECT COUNT(*) n FROM patients WHERE status='Admitted'").get().n;
  db.prepare("UPDATE device_status SET connected=1,ip_address=?,last_sync=datetime('now'),patients_synced=? WHERE id=1").run(ip,n);
  res.json({ok:true,patients_synced:n});
});
app.get('/api/settings', requireAuth, (req,res)=>{
  const rows=db.prepare('SELECT key,value FROM settings').all();res.json(Object.fromEntries(rows.map(x=>[x.key,x.value])));
});
app.put('/api/settings', requireAuth, [
  body('hospital_name').optional().trim().isLength({max:120}),
  body('bot_name').optional().trim().isLength({max:80}),
  body('esp32_api_url').optional().trim().isLength({max:250}),
  body('admin_username').optional().trim().isLength({min:3,max:60}),
  body('current_password').optional().isString(),
  body('new_password').optional().isLength({min:8,max:128})
], validate, (req,res)=>{
  const b=req.body;
  if(b.new_password){
    const admin=db.prepare('SELECT * FROM admins WHERE id=?').get(req.admin.id);
    if(!b.current_password || !bcrypt.compareSync(b.current_password,admin.password_hash))return res.status(400).json({error:'Current password is incorrect'});
    db.prepare('UPDATE admins SET password_hash=? WHERE id=?').run(bcrypt.hashSync(b.new_password,12),req.admin.id);
  }
  if(b.admin_username && b.admin_username!==req.admin.username){
    try{db.prepare('UPDATE admins SET username=? WHERE id=?').run(b.admin_username,req.admin.id);}
    catch(e){if(String(e.code).includes('UNIQUE'))return res.status(409).json({error:'Username already exists'});throw e;}
    db.prepare("INSERT INTO settings(key,value) VALUES('admin_username',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(b.admin_username);
  }
  for(const k of ['hospital_name','bot_name','esp32_api_url']) if(b[k]!==undefined)db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,b[k]);
  res.json({message:'Settings saved'});
});

app.use((req,res)=>res.status(404).json({error:'Endpoint not found'}));
app.use((err,req,res,next)=>{
  console.error(err);
  if(res.headersSent)return next(err);
  res.status(500).json({error:'Internal server error'});
});
app.listen(PORT, ()=>console.log(`Room Track Bot API running at http://localhost:${PORT}`));
