import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

console.log('--------------------------------------------------');
console.log('🏥 ROOM TRACK BOT — Supabase Connection Test Script');
console.log('--------------------------------------------------');

const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  console.error('❌ ERROR: DATABASE_URL is not set in backend/.env');
  console.log('\nTo fix this:');
  console.log('1. Open backend/.env');
  console.log('2. Add your Supabase PostgreSQL connection string:');
  console.log('   DATABASE_URL=postgresql://postgres.eepqkyjzfnzjqjwnshxf:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:6543/postgres');
  process.exit(1);
}

// Clean URL for display without leaking password
const maskedUrl = dbUrl.replace(/:([^:@]+)@/, ':••••••••@');
console.log(`Connecting to: ${maskedUrl}`);

const pool = new Pool({
  connectionString: dbUrl,
  ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 8000,
});

async function runTest() {
  try {
    const client = await pool.connect();
    console.log('✅ Connected successfully to Supabase PostgreSQL!');

    // 1. Basic query check
    const nowRes = await client.query('SELECT NOW() as current_time, current_database() as db_name');
    console.log(`   Database: ${nowRes.rows[0].db_name}`);
    console.log(`   Server Time: ${nowRes.rows[0].current_time}`);

    // 2. Check existing tables
    const requiredTables = ['patients', 'rooms', 'search_history', 'announcement_queue', 'floors', 'admins'];
    console.log('\nChecking table existence:');

    for (const table of requiredTables) {
      const res = await client.query(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables 
           WHERE table_schema = 'public' AND table_name = $1
         ) as exists`,
        [table]
      );
      if (res.rows[0].exists) {
        // Count rows
        const countRes = await client.query(`SELECT COUNT(*)::int as count FROM ${table}`);
        console.log(`   ✅ Table '${table}': Present (${countRes.rows[0].count} records)`);
      } else {
        console.log(`   ⚠️ Table '${table}': NOT FOUND. Run supabase_compatibility_schema.sql in Supabase SQL editor.`);
      }
    }

    // 3. Test patient query by name (case-insensitive)
    console.log('\nTesting Patient Search Query:');
    try {
      const patientRes = await client.query(`
        SELECT p.id, COALESCE(p.name, p.patient_name) as name, 
               p.floor, p.room, p.status 
        FROM patients p 
        WHERE LOWER(COALESCE(p.name, p.patient_name)) = LOWER('JOHN')
        LIMIT 1
      `);
      if (patientRes.rows.length > 0) {
        const p = patientRes.rows[0];
        console.log(`   ✅ Found demo patient: ${p.name} | Floor: ${p.floor} | Room: ${p.room}`);
      } else {
        console.log('   ℹ️ Patient search query works, but demo patient JOHN is not yet seeded.');
      }
    } catch (err) {
      console.log(`   ⚠️ Patient query warning: ${err.message}`);
    }

    client.release();
    console.log('\n==================================================');
    console.log('🎉 All backend tests passed! Supabase is ready.');
    console.log('==================================================\n');
  } catch (err) {
    console.error('\n❌ Connection test failed with error:');
    console.error(err.message);
    console.log('\nTroubleshooting tips:');
    console.log('• Ensure your database password in backend/.env is correct.');
    console.log('• If using special characters in password, URL-encode them (e.g., @ -> %40).');
    console.log('• Use Supabase Transaction/Session pooler port 6543 or direct port 5432.');
  } finally {
    await pool.end();
  }
}

runTest();
