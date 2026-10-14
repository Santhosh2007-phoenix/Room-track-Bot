Set WshShell = CreateObject("WScript.Shell")

' 1. Start Node Backend on Port 4000 silently (0 = hidden window)
WshShell.Run "cmd /c cd /d C:\Users\santh\OneDrive\Documents\room-track-bot-supabase-merged\backend && node server-postgres.js", 0, False

WScript.Sleep 2000

' 2. Start Frontend Website on Port 5173 silently (0 = hidden window)
WshShell.Run "cmd /c cd /d C:\Users\santh\OneDrive\Documents\room-track-bot-supabase-merged\frontend && npm run dev", 0, False
