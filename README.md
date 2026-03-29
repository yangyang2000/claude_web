# Claude Web

A self-hosted web terminal for [Claude Code](https://claude.ai/code), accessible from any browser. Supports multiple users via Google OAuth, persistent sessions, and per-user project directories.

## Features

### Terminal
A full xterm-based terminal running Claude Code in your browser. Input and output stream over WebSocket in real time. If you close the tab or lose connection, the session stays alive on the server for up to 2 hours and replays the output buffer when you reconnect.

### Session history
Click **history** in the header to open the sidebar. Every session you explicitly save (or that gets saved automatically when you switch away) appears here with a title, timestamp, and a snippet of the conversation. You can:
- **Search** sessions by title or content using the search box
- **Continue** a past session by clicking it — the server restarts Claude Code in the same project directory, resuming where you left off
- **Rename** a session by hovering and clicking the pencil icon (✎) next to the title
- **Save** the current session at any time with the **save** button in the sidebar header
- **Delete** individual sessions with the ✕ button, or wipe everything with **clear all**

### Project management
Each session runs Claude Code inside a dedicated project directory under `~/Documents/Claude_Projects/{username}/`. Clicking **new session** (or the current project path shown in the header) opens a project picker where you can:
- Select an existing project folder to open a fresh conversation in that project
- Type a new name to create a new project directory
- Leave blank to start an unnamed session

### Memory management
Two buttons in the header help manage Claude's context window:
- **/compact** — sends Claude Code's `/compact` command, which summarises the conversation into a memory file and clears the context, keeping Claude fast on long sessions
- **refresh memory** — compacts the conversation, saves the session to history, then starts a completely fresh context window in a new session

## Prerequisites

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) installed and authenticated (`claude` must be on your PATH)
- A Google account (for OAuth setup)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/claude_web.git
cd claude_web
npm install
```

### 2. Create a Google OAuth app

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Under **Authorized redirect URIs**, add:
   - `http://localhost:3000/auth/google/callback` (for local use)
   - `https://your-domain.com/auth/google/callback` (for remote access)
5. Copy the **Client ID** and **Client Secret**

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret

# Public URL of this server — must match the OAuth redirect URI above
BASE_URL=http://localhost:3000

# Generate with: openssl rand -hex 32
SESSION_SECRET=replace-with-a-long-random-string

# Optional: change the port (default 3000)
# PORT=3000
```

### 4. Add allowed users

Copy the example whitelist and add the Google email addresses of everyone who should have access:

```bash
cp whitelist.example.json whitelist.json
```

Edit `whitelist.json`:

```json
["you@gmail.com", "familymember@gmail.com"]
```

Anyone not on this list will be blocked after Google login.

### 5. Run

```bash
npm start
```

Open `http://localhost:3000` in your browser.

## Project storage

Each session's files are stored under:

```
~/Documents/Claude_Projects/{google-username}/{project-name}/
```

When starting a new session you'll be prompted to pick an existing project folder or name a new one. Session metadata (history, titles) is kept separately in `users/` inside the app directory.

## Remote access

To expose the server to the internet (e.g. so you can reach your home machine from anywhere):

1. Set `BASE_URL` in `.env` to your public URL (e.g. `https://claude.yourdomain.com`)
2. Make sure the OAuth redirect URI in Google Cloud Console matches
3. Use a reverse proxy (nginx, Caddy) or a tunnel (ngrok, Cloudflare Tunnel) in front of port 3000
4. Use HTTPS — the session cookie is set to `secure: true` when `BASE_URL` starts with `https://`

## Running as a service (optional)

To keep it running after you close your terminal, create a systemd service:

```bash
sudo nano /etc/systemd/system/claude-web.service
```

```ini
[Unit]
Description=Claude Web Terminal
After=network.target

[Service]
User=YOUR_USERNAME
WorkingDirectory=/path/to/claude_web
ExecStart=/usr/bin/node server.js
Restart=on-failure
EnvironmentFile=/path/to/claude_web/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now claude-web
```
