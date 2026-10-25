# Process lifecycle (agent-owned)

> Audience: AI agents and developers working in this repo.
> `.devin/rules/dev-server.md` is a pointer to this page — this is the
> canonical text.

This repo is a library — it has no dev server of its own. The rule below
applies to ANY long-lived process you spawn or find here (watch builds,
test runners, vitest, docs servers) and to shared dev ports owned by other
repos (FE 5173, BE 3001, US services 3003–3007).

## Golden rules

1. **The agent owns the process lifecycle** — start, stop, restart are
   autonomous operations, no ask-first.
2. **A process that is provably user-started is NEVER killed** without
   explicit user permission — and "not user-started" must be PROVEN
   empirically (see below), never assumed from "the port is busy" or
   "I didn't start it".
3. **Never duplicate, never migrate**: no second process on the same port.

## Procedure — before starting or touching a long-lived process

1. Check the port if one is involved (Windows):
   `netstat -ano | findstr "LISTENING" | findstr ":<port>"`
2. Port free / no conflict → act autonomously (background shell, keep the
   `shell_id`; stop verification-only processes when done).
3. Port busy or a process already running → identify the owner empirically:
   ```powershell
   Get-CimInstance Win32_Process -Filter 'ProcessId=<pid>' |
     Select-Object ProcessId, ParentProcessId, CommandLine | Format-List
   ```
   Walk the **parent chain** (repeat on `ParentProcessId` until root):
   - **User-started** — chain reaches an IDE terminal or user shell
     (`Code.exe`/`Windsurf.exe`/`Devin.exe` → `conhost.exe` →
     `powershell`/`cmd`): reuse, never kill, never duplicate. Need its
     output? Ask for access to the running terminal — do not restart.
   - **Orphan** — broken chain or no live terminal ancestor (leftover
     agent shell, dead IDE session): agent-owned, may kill and restart
     on the SAME port.
4. Wrong-app conflict: same owner test — user-started → ask which project
   owns the port; orphan → kill or escalate. Never steal a port silently.
