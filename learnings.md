# Learnings

## 2026-03-29 (session 3)

- **node-pty `onData` returns a disposable**: `ptyProcess.onData(cb)` returns an `IDisposable` with a `.dispose()` method. Always store it and call `.dispose()` when done to avoid listener accumulation — especially in one-shot flows like `/session/refresh` that register a temporary listener.
- **Snapshot buffers before mutating state**: When using a PTY buffer for title/snippet extraction after a command (like `/compact`), snapshot the buffer *before* issuing the command. The command's output will contaminate the buffer and produce useless titles like "I'll compact this conversation…".
- **In-memory caching for config files**: For single-process apps with infrequent config changes, module-level cache variables (`let _cache = null`) updated on every write are simpler and more correct than file watchers or TTL caches. Writers update both memory and disk atomically.
- **Stable IDs for config array entries**: Any array entry managed via API (add/delete/update) needs a stable ID, not an array index. Index-based routes break under concurrent edits. Auto-migrate on first load: `list.map(p => p.id ? p : { id: newId(), ...p })`.
- **Graceful PTY shutdown on SIGTERM/SIGINT**: Register handlers that call `killSession` for each live entry, then `server.close()`. Add a force-exit timeout (e.g. 5s) as a fallback in case `server.close` stalls due to open WebSocket connections.
- **`session/refresh` should preserve workDir**: After compacting and restarting, users expect to stay in the same project. Pass `{ workDir: savedWorkDir }` to `startSession` instead of letting it create a new unnamed directory.

## 2026-03-29 (session 2)

- **PTY env leaks server secrets**: `pty.spawn(..., { env: process.env })` passes the entire server environment — including `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — to the child process. Any user with terminal access can run `printenv` and read them. Fix: copy and strip sensitive keys before spawning (`const ptyEnv = { ...process.env }; delete ptyEnv.SESSION_SECRET; ...`).
- **Admin middleware should detect browser vs API requests**: A single `requireAdmin` middleware that always returns JSON 403 is wrong for browser navigation. Check `req.xhr || req.headers.accept.includes('application/json')` to decide between a redirect and a JSON error response.
- **Shared project feature**: Added `shared_projects.json` mapping folder paths to user email arrays. Shared folders appear in the project panel with a "shared" badge, are never deleted when a session is removed, and are validated in `isAuthorizedWorkDir` to prevent path traversal to unauthorized directories.
- **Admin panel**: Added `/admin` route (served from `admin.html` outside `public/` so it's never served statically) with Google OAuth-gated access via `admins.json`. Super admin (`yangyang2000@gmail.com`) is hardcoded as a constant and cannot be removed via UI. Non-admins are redirected rather than shown raw JSON.

## 2026-03-29

- **Bash login vs non-login shells**: `~/.bash_profile` is sourced for login shells; `~/.bashrc` is sourced for interactive non-login shells. If `~/.bash_profile` exists but doesn't source `~/.bashrc`, aliases defined in `~/.bashrc` won't appear in login shell terminals.
- **Fix**: Add `[[ -f ~/.bashrc ]] && source ~/.bashrc` to `~/.bash_profile`. This is especially common when Anaconda installs and creates a minimal `~/.bash_profile` with only its PATH export.
