# Supabase PostgreSQL setup

1. Create a Supabase project.
2. Run `schema.sql` in Supabase SQL Editor.
3. Copy `backend/.env.supabase.example` to `backend/.env` and set the database URI and secrets.
4. Run `npm install` and `npm run dev:supabase` from `backend/`.

Use the PostgreSQL URI from Supabase Project Settings → Database. Keep it in the backend environment only. Never expose it in frontend variables or commit it to source control.
