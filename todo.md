# TODO

Identified 2026-03-29. All items resolved 2026-03-29.

## Real bugs

**1. `/session/refresh` loses project context** ✅ fixed
`startSession` in the refresh handler now passes `{ workDir: savedWorkDir }` so the new session stays in the same project directory.

**2. Shared projects use array index as identifier** ✅ fixed
Each shared project now has a stable `id` field (random hex, auto-migrated on first load). Admin routes use `/:id` with `findIndex` lookup instead of `/:index`.

**3. `DELETE /api/sessions` (clear all) doesn't clean up directories** ✅ fixed
Clear-all now iterates sessions and deletes each non-shared project directory before wiping the history file.

---

## Reliability issues

**6. `onData` listener accumulates on repeated `/session/refresh` calls** ✅ fixed
`ptyProcess.onData()` returns an `IDisposable`. The disposable is now stored and `.dispose()` is called inside `doRestart` before the session is killed.

**7. No graceful shutdown** ✅ fixed
`SIGTERM` and `SIGINT` handlers now kill all live PTY sessions and call `server.close()`. A 5-second force-exit fallback prevents hanging.

---

## UX / quality issues

**8. Session titles capture Claude's boilerplate, not meaningful content** ✅ fixed
The buffer is snapshotted before writing `/compact`. `extractTitleAndSnippet` runs on `preCompactBuffer` instead of the compact output tail.

**9. Config files read synchronously on every request** ✅ fixed
`whitelist`, `admins`, and `sharedProjects` are now cached in module-level variables. Each writer updates both the in-memory cache and the file atomically.

**10. Admin panel has no visibility into active sessions** ✅ fixed
New "Active Sessions" card in admin.html shows connected users, their working directory, and client count. Each session has a kill button. Backed by `GET/DELETE /admin/api/active-sessions`.
