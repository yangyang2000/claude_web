# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A self-hosted web interface for accessing Claude Code running on a home server remotely. It wraps the `claude` CLI in a PTY and exposes it over WebSocket, with Google OAuth gating access to a trusted whitelist of family members. Each user gets their own isolated PTY process and session history.

## Running

```bash
npm start        # node server.js, listens on PORT (default 3000)
```

No build step. No test suite. No linter configured.

## Configuration

Copy `.env.example` to `.env` and fill in:
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from Google Cloud Console → Credentials
- `BASE_URL` — public URL (must match OAuth callback; use `https://` in prod)
- `SESSION_SECRET` — generate with `openssl rand -hex 32`
- `PORT` — optional, defaults to 3000

Add allowed emails to `whitelist.json` (JSON array of strings).

## Architecture

**server.js** is the entire backend (~370 lines):

- **Auth**: Passport.js with Google OAuth 2.0. The whitelist check happens in the OAuth verify callback. Sessions use signed cookies (7-day expiry). The WebSocket upgrade path manually re-runs the session parser to authenticate WS connections since `passport.session()` doesn't cover the upgrade.

- **PTY sessions**: One `node-pty` process (running `claude`) per authenticated user, stored in `live: Map<email, session>`. Each session has a 200KB output ring buffer for replaying to reconnecting clients. Idle sessions (no WebSocket clients) are killed after 2 hours.

- **Persistence**: App metadata lives in `users/<sanitized-email>/` — `sessions.json` (up to 100 entries, FIFO eviction) and `active.json` (current session id + workDir). Project files live in `~/Documents/Claude_Projects/<username>/` where each session gets its own subdirectory named after the project name (if given) or the session ID. The `workDir` path is stored in each `sessions.json` entry so the app always knows where a session's files live regardless of naming.

- **Session lifecycle**:
  - New WebSocket connection → check `live` map → if active, replay buffer and attach; otherwise check `active.json` → resume at stored `workDir` or create new session
  - `POST /session/reset` → accepts optional `{ projectName }` body; kills current PTY, creates new session id, resolves work directory as `~/Documents/Claude_Projects/<username>/<projectName>` (with numeric suffix on collision) or `<id>` if unnamed
  - `POST /session/refresh` → write `/compact\r` to PTY, wait for output to settle (500ms) or timeout (20s), save title/snippet+workDir to history, then reset to a new session

- **Frontend** (`public/index.html`): Single-page xterm.js terminal. Communicates via WebSocket messages: `{type:'input', data}`, `{type:'resize', cols, rows}`, `{type:'output', data}`, `{type:'meta', resumed, restarted}`. Sidebar shows session history fetched from `GET /api/sessions`.

## API routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/auth/google` | Start OAuth flow |
| GET | `/auth/google/callback` | OAuth callback |
| GET | `/logout` | Destroy session |
| GET | `/me` | Current user info + hasSession |
| GET | `/api/sessions` | List session history |
| DELETE | `/api/sessions` | Clear all history |
| DELETE | `/api/sessions/:id` | Delete one session + its directory |
| POST | `/api/sessions/:id/resume` | Kill current PTY and resume saved session |
| POST | `/session/reset` | Kill current PTY, start fresh session |
| POST | `/session/refresh` | Compact + save to history + start fresh |
