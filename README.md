# Claude Web

> **⚠️ Private use only.** This app is designed for a small circle of trusted users — family, close friends, or colleagues you personally know. Every whitelisted user gets full terminal access to your server and can read and write files in your project directories. Do not expose this to the public internet or add anyone you don't fully trust.

A self-hosted web terminal for [Claude Code](https://claude.ai/code), accessible from any browser. Supports multiple users via Google OAuth, persistent sessions, per-user project directories, and an admin panel for managing users and shared projects.

## Features

### Terminal
A full xterm-based terminal running Claude Code in your browser. Input and output stream over WebSocket in real time. If you close the tab or lose connection, the session stays alive on the server and replays the output buffer when you reconnect. The idle timeout and output buffer size are both configurable in the admin panel (defaults: 2 hours, 200 KB).

### Simple / mobile view
Click **simple** in the header to switch from the xterm terminal to a plain-text view with a bottom input bar. The simple view strips ANSI escape codes and renders output as readable text — much more usable on a phone. Click **terminal** to switch back. Your preference is saved across sessions.

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

### File browser
Click **⊞** in the header to open a file browser panel showing the current project directory. Click any file to view its contents — the tree hides and the file fills the panel. Use **⤢** to expand the browser to the full window, and **⤡** to restore the split. The file viewer size limit is configurable in the admin panel (default 5 MB).

### Memory management
The **refresh** button in the header compacts the conversation, saves the session to history, then starts a fresh context window in a new session. To compact without switching sessions, type `/compact` directly in the terminal.

### Admin panel
Accessible at `/admin` by admin users. Lets you:
- **Manage the whitelist** — add or remove users who can log in
- **Manage admins** — promote users to admin or demote them (super admin only)
- **Shared projects** — create shared project directories that multiple users can access; click a project's name or path to edit it inline
- **Active sessions** — see who is connected, their working directory, and kill any session
- **Settings** (super admin only) — configure the user projects directory, idle session timeout, file viewer size limit, and terminal output buffer size

The super admin is set via `SUPER_ADMIN_EMAIL` in `.env`. This account has exclusive control over admin promotion and server-wide settings, and cannot be removed via the UI.

## Architecture

Claude Web is a single Node.js server (`server.js`) with no build step. The browser connects over WebSocket; the server runs the `claude` CLI in a pseudo-terminal (PTY) and streams I/O between them.

```
Browser
  ├── HTTP (Express)   — pages, OAuth, REST API
  └── WebSocket        — real-time terminal I/O
          └── node-pty — runs claude in a PTY
                  └── claude CLI
```

**Auth** — Passport.js with Google OAuth 2.0. The user's email is checked against `whitelist.json` on login. WebSocket upgrades manually re-run the session parser since Passport doesn't cover the upgrade path.

**PTY sessions** — one `node-pty` process per user, stored in a `Map` keyed by email. Each entry holds the process, an output ring buffer replayed to reconnecting clients (configurable, default 200 KB), a set of active WebSocket clients (multiple tabs share one PTY), and an idle kill timer (configurable, default 2 hr).

**Persistence** — two files per user under `users/<email>/`: `sessions.json` (up to 100 past sessions with title, snippet, timestamp, and working directory) and `active.json` (current session ID and working directory, used to resume after a server restart).

**Project directories** — each session runs `claude` in a dedicated folder. The root is configurable via `settings.json` (default `~/Documents/Claude_Projects`); each user gets a subfolder by their Google username, and each project gets a subfolder within that.

**Admin API** — routes under `/admin/api/` manage `whitelist.json`, `admins.json`, `shared_projects.json`, and `settings.json`. The super admin (`SUPER_ADMIN_EMAIL`) has exclusive control over admin promotion and server-wide settings.

**Frontend** (`public/index.html`) — a single HTML file using xterm.js for the terminal and plain JS for the WebSocket client and session history sidebar. No framework, no build step.

### WebSocket messages

| Direction | Type | Meaning |
|---|---|---|
| client → server | `input` | Keystrokes to write to PTY |
| client → server | `resize` | Terminal dimensions changed |
| server → client | `output` | Raw terminal output |
| server → client | `meta` | Session started or resumed (includes `sessionId`, `workDir`) |
| server → client | `exit` | PTY process exited |

### Session lifecycle

On each new WebSocket connection the server checks: is there a live PTY for this user? If yes, replay the buffer and attach. If no, check `active.json` — if the working directory still exists on disk, resume there; otherwise start a fresh session with a new ID and project directory.

`POST /session/refresh` is the one complex flow: it writes `/compact\r` to the PTY, waits for output to settle (500 ms debounce, 20 s hard timeout), snapshots the pre-compact buffer for the session title, saves to history, then starts a fresh session in the same working directory.

---

## Prerequisites

- Node.js 18+
- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- A Google account (for OAuth setup)

**Platform notes:**

- **Linux** — no extra steps. Make sure `claude` is on your PATH.
- **Mac** — `node-pty` requires Xcode CLI tools: `xcode-select --install`. If `~/Documents` is synced to iCloud, consider changing the projects directory in the admin Settings panel to avoid sync conflicts (e.g. `~/claude-projects`).
- **Windows** — `node-pty` requires C++ build tools. Run `npm install -g windows-build-tools` (as Administrator) before `npm install`. If `claude` isn't available in a PTY environment, set `CLAUDE_PATH` in `.env` to its full path (e.g. `C:\Users\you\AppData\Roaming\npm\claude.cmd`).

## Setup

### Option A: Interactive setup script

**Linux / Mac:**
```bash
git clone https://github.com/YOUR_USERNAME/claude-web.git
cd claude-web
./setup.sh
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/YOUR_USERNAME/claude-web.git
cd claude-web
powershell -ExecutionPolicy Bypass -File setup.ps1
```

The script walks you through creating `.env`, populating `whitelist.json`, and running `npm install`. You'll still need to create a Google OAuth app first (see step 2 below).

---

### Option B: Manual setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/claude-web.git
cd claude-web
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

# Your Google email — this account is the permanent super admin and cannot be removed via the UI
SUPER_ADMIN_EMAIL=you@gmail.com

# Optional: change the port (default 3000)
# PORT=3000
```

### 4. Add allowed users

```bash
cp whitelist.example.json whitelist.json
```

Edit `whitelist.json` with the Google email addresses of everyone who should have access:

```json
["you@gmail.com", "familymember@gmail.com"]
```

Anyone not on this list will be blocked after Google login. You can also manage the whitelist at runtime via the admin panel.

### 5. Run

```bash
npm start
```

Open `http://localhost:3000` in your browser. The first time you log in with your `SUPER_ADMIN_EMAIL` account, you'll automatically have admin access.

## Project storage

Each session's files are stored under:

```
~/Documents/Claude_Projects/{google-username}/{project-name}/
```

When starting a new session you'll be prompted to pick an existing project folder or name a new one. Session metadata (history, titles) is kept separately in `users/` inside the app directory.

## Remote access

### Option A: Dynamic DNS + port forwarding (host it yourself)

This is the best option if you want to run Claude Web on a home machine and reach it from anywhere, without paying for a VPS.

**1. Get a dynamic DNS hostname**

Your home IP address changes periodically. A dynamic DNS (DDNS) service gives you a stable hostname (e.g. `yourname.duckdns.org`) that automatically updates when your IP changes.

- [DuckDNS](https://www.duckdns.org/) — free, simple, widely used
- [No-IP](https://www.noip.com/) — free tier available
- [Cloudflare](https://www.cloudflare.com/) — free if you own a domain; use their DDNS API

For DuckDNS, create an account, pick a subdomain, then set up the update client on your machine:
```bash
# Example cron job to keep DuckDNS updated every 5 minutes
*/5 * * * * curl -s "https://www.duckdns.org/update?domains=yourname&token=your-token&ip=" > /dev/null
```

**2. Forward the port on your router**

Log in to your router admin panel (usually `192.168.1.1` or `192.168.0.1`) and add a port forwarding rule:

| Setting | Value |
|---|---|
| External port | 443 (HTTPS) |
| Internal IP | Your machine's local IP (e.g. `192.168.1.100`) |
| Internal port | 3000 (or whichever port Claude Web runs on) |
| Protocol | TCP |

To find your machine's local IP: `ip addr show | grep "inet "` (Linux) or `ipconfig` (Windows).

**3. Set up HTTPS with Caddy (recommended)**

Caddy automatically provisions and renews a free TLS certificate via Let's Encrypt. Install it, then create a `Caddyfile`:

```
yourname.duckdns.org {
    reverse_proxy localhost:3000
}
```

Start Caddy:
```bash
caddy run --config Caddyfile
```

Caddy handles HTTPS automatically. No certificate management needed.

**4. Update your config**

Set `BASE_URL` in `.env` to your DDNS hostname:
```env
BASE_URL=https://yourname.duckdns.org
```

Add the OAuth redirect URI in Google Cloud Console:
```
https://yourname.duckdns.org/auth/google/callback
```

---

### Option B: Cloudflare Tunnel (no port forwarding required)

If your router doesn't support port forwarding, or you'd rather not expose your home IP, Cloudflare Tunnel creates an outbound-only encrypted tunnel — no inbound firewall rules needed.

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared && sudo mv cloudflared /usr/local/bin

# Authenticate and create a tunnel
cloudflared tunnel login
cloudflared tunnel create claude-web
cloudflared tunnel route dns claude-web claude.yourdomain.com

# Run the tunnel
cloudflared tunnel run --url http://localhost:3000 claude-web
```

Requires a domain on Cloudflare's free plan. Once running, set `BASE_URL=https://claude.yourdomain.com` and add the matching OAuth redirect URI.

---

### Option C: ngrok (quick and temporary)

Good for testing but not reliable as a permanent solution (URL changes on restart unless you pay).

```bash
ngrok http 3000
```

Copy the `https://...ngrok-free.app` URL into `BASE_URL` and the Google OAuth redirect URI.

## Running as a service (optional)

### Linux — systemd

```bash
sudo nano /etc/systemd/system/claude-web.service
```

```ini
[Unit]
Description=Claude Web Terminal
After=network.target

[Service]
User=YOUR_USERNAME
WorkingDirectory=/path/to/claude-web
ExecStart=/usr/bin/node server.js
Restart=on-failure
EnvironmentFile=/path/to/claude-web/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now claude-web
```

---

### Mac — launchd

Create `~/Library/LaunchAgents/com.claude-web.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.claude-web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/claude-web/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/path/to/claude-web</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/YOUR_USERNAME</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/claude-web.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/claude-web.log</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

> Note: launchd doesn't load `.env` automatically. Either hardcode env vars in the `EnvironmentVariables` dict, or prefix the `node` call with a wrapper script that sources `.env` first.

```bash
launchctl load ~/Library/LaunchAgents/com.claude-web.plist
```

---

### Windows — NSSM

[NSSM](https://nssm.cc) (Non-Sucking Service Manager) wraps any executable as a Windows service.

```powershell
# Install NSSM (e.g. via Chocolatey)
choco install nssm

# Register the service (run as Administrator)
nssm install claude-web "C:\Program Files\nodejs\node.exe" "C:\path\to\claude-web\server.js"
nssm set claude-web AppDirectory "C:\path\to\claude-web"
nssm set claude-web AppEnvironmentExtra "NODE_ENV=production"

# Start it
nssm start claude-web
```

Environment variables from `.env` are loaded automatically by the app via `dotenv`.
