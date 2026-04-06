require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DEFAULT_IDLE_TIMEOUT_HOURS = 2;
function getIdleTimeoutMs() {
  const h = getSettings().idleTimeoutHours;
  return (typeof h === 'number' && h > 0 ? h : DEFAULT_IDLE_TIMEOUT_HOURS) * 60 * 60 * 1000;
}
const DEFAULT_OUTPUT_BUFFER_KB = 200;
function getOutputBufferSize() {
  const kb = getSettings().outputBufferKb;
  return (typeof kb === 'number' && kb > 0 ? kb : DEFAULT_OUTPUT_BUFFER_KB) * 1024;
}
const MAX_SESSIONS = 100;

function newId() { return crypto.randomBytes(6).toString('hex'); }

// ── Whitelist ─────────────────────────────────────────────────────────────────

const whitelistPath = path.join(__dirname, 'whitelist.json');
if (!fs.existsSync(whitelistPath)) fs.writeFileSync(whitelistPath, '[]');

let _whitelist = null;
function getWhitelist() {
  if (!_whitelist) {
    try { _whitelist = JSON.parse(fs.readFileSync(whitelistPath, 'utf8')); }
    catch (_) { _whitelist = []; }
  }
  return _whitelist;
}
function saveWhitelist(list) {
  _whitelist = list;
  fs.writeFileSync(whitelistPath, JSON.stringify(list, null, 2));
}

// ── Admins ────────────────────────────────────────────────────────────────────
// admins.json: array of email strings. SUPER_ADMIN can never be removed via UI.

const SUPER_ADMIN = process.env.SUPER_ADMIN_EMAIL;
const adminsPath  = path.join(__dirname, 'admins.json');
if (!fs.existsSync(adminsPath)) fs.writeFileSync(adminsPath, JSON.stringify([SUPER_ADMIN], null, 2));

let _admins = null;
function getAdmins() {
  if (!_admins) {
    try { _admins = JSON.parse(fs.readFileSync(adminsPath, 'utf8')); }
    catch (_) { _admins = [SUPER_ADMIN]; }
  }
  return _admins;
}
function saveAdmins(list) {
  _admins = list;
  fs.writeFileSync(adminsPath, JSON.stringify(list, null, 2));
}

// ── Settings ──────────────────────────────────────────────────────────────────
// settings.json: { "projectsBase": "/absolute/path" }
// Supports leading ~ which is expanded to homedir at runtime.

const settingsPath = path.join(__dirname, 'settings.json');
let _settings = null;
function getSettings() {
  if (!_settings) {
    try { _settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
    catch (_) { _settings = {}; }
  }
  return _settings;
}
function saveSettings(obj) {
  _settings = obj;
  fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2));
}
function getProjectsBase() {
  const raw = getSettings().projectsBase;
  if (!raw) return path.join(os.homedir(), 'Documents', 'Claude_Projects');
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

// ── Shared projects ───────────────────────────────────────────────────────────
// shared_projects.json: [{ "id": "hex", "path": "/abs/path", "name": "Label", "users": ["email@..."] }]

const sharedProjectsPath = path.join(__dirname, 'shared_projects.json');

let _sharedProjects = null;
function getSharedProjects() {
  if (!_sharedProjects) {
    let list;
    try { list = JSON.parse(fs.readFileSync(sharedProjectsPath, 'utf8')); }
    catch (_) { _sharedProjects = []; return _sharedProjects; }
    // Migrate: assign stable IDs to any entries that don't have one
    let needsSave = false;
    list = list.map(p => { if (!p.id) { needsSave = true; return { id: newId(), ...p }; } return p; });
    if (needsSave) fs.writeFileSync(sharedProjectsPath, JSON.stringify(list, null, 2));
    _sharedProjects = list;
  }
  return _sharedProjects;
}
function saveSharedProjects(list) {
  _sharedProjects = list;
  fs.writeFileSync(sharedProjectsPath, JSON.stringify(list, null, 2));
}
function getAccessibleSharedProjects(email) {
  return getSharedProjects().filter(p => Array.isArray(p.users) && p.users.includes(email));
}
function isSharedProjectPath(workDir) {
  return getSharedProjects().some(p => workDir === p.path);
}
function isAuthorizedWorkDir(email, workDir) {
  const username     = email.split('@')[0];
  const personalBase = path.join(getProjectsBase(), username);
  const normalized   = path.resolve(workDir);
  if (normalized.startsWith(personalBase + path.sep) || normalized === personalBase) return true;
  return getAccessibleSharedProjects(email).some(p => path.resolve(p.path) === normalized);
}
function isAuthorizedPath(email, absPath) {
  const username     = email.split('@')[0];
  const personalBase = path.join(getProjectsBase(), username);
  if (absPath.startsWith(personalBase + path.sep) || absPath === personalBase) return true;
  return getAccessibleSharedProjects(email).some(p => {
    const sp = path.resolve(p.path);
    return absPath.startsWith(sp + path.sep) || absPath === sp;
  });
}

// ── Express + Auth ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const sessionParser = session({
  secret: process.env.SESSION_SECRET || 'insecure-default-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: BASE_URL.startsWith('https'), httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 },
});

app.use(sessionParser);
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${BASE_URL}/auth/google/callback`,
  },
  (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    if (!email) return done(null, false);
    if (!getWhitelist().includes(email)) {
      console.log(`[auth] blocked: ${email}`);
      return done(null, false, { message: 'not_whitelisted' });
    }
    console.log(`[auth] ok: ${email}`);
    return done(null, { id: profile.id, email, name: profile.displayName, avatar: profile.photos?.[0]?.value });
  }
));

passport.serializeUser((u, done) => done(null, u));
passport.deserializeUser((u, done) => done(null, u));

// ── Session storage helpers ───────────────────────────────────────────────────

function userDataDir(email) {
  return path.join(__dirname, 'users', email.replace(/[^a-zA-Z0-9._-]/g, '_'));
}

function sessionsFilePath(email) { return path.join(userDataDir(email), 'sessions.json'); }
function activeFilePath(email)   { return path.join(userDataDir(email), 'active.json'); }

// ── Project directory helpers ─────────────────────────────────────────────────

function sanitizeDir(name) {
  return (name || '').trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64) || null;
}

// {projectsBase}/{username}/{project_name_or_id}
function resolveWorkDir(email, id, projectName) {
  const username = email.split('@')[0];
  const base     = path.join(getProjectsBase(), username);
  const safeName = sanitizeDir(projectName);
  if (!safeName) return path.join(base, id);

  let dir = path.join(base, safeName);
  let n = 2;
  while (fs.existsSync(dir)) dir = path.join(base, `${safeName}-${n++}`);
  return dir;
}

function loadSessionHistory(email) {
  try { return JSON.parse(fs.readFileSync(sessionsFilePath(email), 'utf8')); }
  catch (_) { return []; }
}

function saveSessionHistory(email, list) {
  const dir = userDataDir(email);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sessionsFilePath(email), JSON.stringify(list, null, 2));
}

function pushToHistory(email, entry) {
  let list = loadSessionHistory(email).filter(s => s.id !== entry.id);
  list.unshift(entry);
  if (list.length > MAX_SESSIONS) list = list.slice(0, MAX_SESSIONS);
  saveSessionHistory(email, list);
}

function loadActive(email) {
  try { return JSON.parse(fs.readFileSync(activeFilePath(email), 'utf8')); }
  catch (_) { return null; }
}

function saveActive(email, sessionId, workDir) {
  const dir = userDataDir(email);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(activeFilePath(email), JSON.stringify({ sessionId, workDir }));
}

function stripAnsi(str) {
  return str
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// Tool/progress/UI-chrome lines from Claude Code CLI — suppress in simple chat view
function isToolLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (t.length < 4) return true;                      // animation artifacts (partial frames)
  if (/\(thinking\)/.test(t)) return true;            // thinking mode marker
  if (/^\w+…$/.test(t)) return true;                  // bare spinner label "Tempering…"
  if (/^[●⎿◆▸✓✗·✢✶✻✽⚙]/.test(t)) return true;     // tool call / spinner indicators
  if (/^[\u2800-\u28FF]/.test(t)) return true;       // Braille spinners
  if (/^[\u2580-\u259F]/.test(t)) return true;       // block element chars (▐▛▜▝▘ etc.)
  if (/[\u2580-\u259F]{2,}/.test(t)) return true;    // 2+ block element chars anywhere
  if (/^[─═━┄┅┈┉╌╍\-]{4,}$/.test(t)) return true;  // separator lines
  if (/[─═━]{4,}/.test(t)) return true;              // long separators anywhere
  if (/^Context[\[:\s]/.test(t)) return true;        // context window bar (Context[ or Context: or Context n…)
  if (/^◐/.test(t)) return true;                     // model/effort indicator
  if (/^❯/.test(t)) return true;                     // input echo (bare or with content)
  if (/[█░▓▒]{2,}/.test(t)) return true;             // progress bars
  if (/^\*\s+\S.*[….]$/.test(t)) return true;        // "* Canoodling…" thinking status
  if (/%\s*used/.test(t) || /%\s*r(emaining)?/.test(t)) return true; // context % display
  if (/^v\d+\.\d+/.test(t)) return true;             // version strings (v2.1.92)
  if (/^\d+\.\d+(\.\d+)?$/.test(t)) return true;     // bare version numbers (4.6, 2.1.92)
  if (/^Claude\s*$/.test(t)) return true;             // bare "Claude" splash line
  if (/^Claude\s*Code/.test(t)) return true;          // "Claude Code" / "ClaudeCode..." splash
  if (/^(Sonnet|Haiku|Opus)\s*(\d.*)?$/.test(t)) return true;  // model names alone on a line
  if (/^Read\s*\d+\s*file/i.test(t)) return true;    // "Read 1 file" / "Read1 file" tool lines
  if (/^\(ctrl\+/.test(t) || /\(ctrl\+o\s*to/.test(t)) return true; // keyboard hints
  if (/expand\)\s*$/.test(t)) return true;            // "(ctrl+o to expand)"
  if (/^…[/\\]/.test(t)) return true;                // truncated paths (…/project)
  if (/^\/\w+\s*$/.test(t)) return true;             // bare slash commands (/buddy)
  return false;
}

// filterChatText: read the current screen of a persistent headless terminal
// (all PTY bytes already written) and return non-chrome rows.  Returns a Promise<string>.
function filterChatText(term) {
  return new Promise((resolve) => {
    // Empty write flushes any queued parser work before we read the buffer.
    term.write('', () => {
      const lines = [];
      for (let row = 0; row < term.rows; row++) {
        const line = term.buffer.active.getLine(row)?.translateToString(true)?.trimEnd() || '';
        if (line.trim()) lines.push(line);
      }
      const kept = lines.filter(l => !isToolLine(l));
      console.log(`[filterChatText] ${lines.length} nonEmpty rows, ${kept.length} kept`);
      if (kept.length) console.log(`[filterChatText] kept first 5:\n${kept.slice(0,5).map(l=>'  '+JSON.stringify(l)).join('\n')}`);
      resolve(kept.join('\n'));
    });
  });
}

function extractTitleAndSnippet(rawOutput) {
  const lines = stripAnsi(rawOutput)
    .split(/[\r\n]+/)
    .map(l => l.trim())
    .filter(l => l.length > 15 && !/^[─═\-─┄]+$/.test(l));  // skip decorative lines
  const snippet = lines.slice(0, 4).join(' ').replace(/\s+/g, ' ').slice(0, 200);
  const title   = lines[0]?.slice(0, 70) || null;
  return { title, snippet };
}

// ── PTY / runtime sessions ────────────────────────────────────────────────────
// email → { ptyProcess, buffer, clients: Set<ws>, killTimer, sessionId, workDir }

const live = new Map();

// opts: { projectName, workDir } — workDir takes precedence (used for resume)
function startSession(user, sessionId, opts = {}) {
  const email   = user.email;
  const workDir = opts.workDir || resolveWorkDir(email, sessionId, opts.projectName);
  fs.mkdirSync(workDir, { recursive: true });

  const ptyEnv = { ...process.env };
  delete ptyEnv.SESSION_SECRET;
  delete ptyEnv.GOOGLE_CLIENT_ID;
  delete ptyEnv.GOOGLE_CLIENT_SECRET;

  const ptyProcess = pty.spawn(process.env.CLAUDE_PATH || 'claude', [], {
    name: 'xterm-256color', cols: 220, rows: 50, cwd: workDir, env: ptyEnv,
  });

  // Persistent headless terminal — mirrors the PTY screen so cursor-positioning
  // sequences are applied correctly across the entire session lifetime.
  const termVt = new HeadlessTerminal({ cols: 220, rows: 50, allowProposedApi: true });

  const sess = { ptyProcess, buffer: '', clients: new Set(), killTimer: null, sessionId, workDir,
               chatLog: [], chatSettleTimer: null, termVt };
  live.set(email, sess);
  saveActive(email, sessionId, workDir);

  ptyProcess.onData((data) => {
    sess.buffer += data;
    const bufLimit = getOutputBufferSize();
    if (sess.buffer.length > bufLimit) sess.buffer = sess.buffer.slice(-bufLimit);
    const msg = JSON.stringify({ type: 'output', data });
    sess.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(msg); });

    // Feed the persistent VT so it tracks full screen state.
    sess.termVt.write(data);
    clearTimeout(sess.chatSettleTimer);
    sess.chatSettleTimer = setTimeout(async () => {
      const text = (await filterChatText(sess.termVt)).trim();
      console.log(`[chat settle] filtered="${text.slice(0,120)}"`);
      if (!text) { console.log('[chat settle] empty after filter, skipping'); return; }
      const append = sess.chatLog.length > 0 && sess.chatLog[sess.chatLog.length - 1].role === 'claude';
      if (append) {
        sess.chatLog[sess.chatLog.length - 1].text += '\n' + text;
      } else {
        sess.chatLog.push({ role: 'claude', text });
      }
      const entry = sess.chatLog[sess.chatLog.length - 1];
      const chatMsg = JSON.stringify({ type: 'chat_claude', text: entry.text, replace: append });
      sess.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(chatMsg); });
    }, 600);
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[${email}] exited (${exitCode})`);
    const msg = JSON.stringify({ type: 'exit', code: exitCode });
    sess.clients.forEach(c => { if (c.readyState === c.OPEN) { c.send(msg); c.close(); } });
    // Clean up timers and headless terminal — don't call killSession since that
    // would try to kill an already-dead PTY process.
    clearTimeout(sess.killTimer);
    clearTimeout(sess.chatSettleTimer);
    try { sess.termVt.dispose(); } catch (_) {}
    live.delete(email);
  });

  return sess;
}

function killSession(email) {
  const sess = live.get(email);
  if (!sess) return;
  clearTimeout(sess.killTimer);
  clearTimeout(sess.chatSettleTimer);
  try { sess.ptyProcess.kill(); } catch (_) {}
  try { sess.termVt.dispose(); } catch (_) {}
  live.delete(email);
}

function broadcast(email, msg) {
  const sess = live.get(email);
  if (!sess) return;
  const raw = JSON.stringify(msg);
  sess.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(raw); });
}

// ── HTTP routes ───────────────────────────────────────────────────────────────

app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));

app.get('/auth/google/callback',
  (req, res, next) => {
    passport.authenticate('google', (err, user) => {
      if (err) return res.redirect('/login?error=auth_failed');
      if (!user) return res.redirect('/login?error=not_whitelisted');
      req.logIn(user, loginErr => {
        if (loginErr) return next(loginErr);
        res.redirect('/');
      });
    })(req, res, next);
  }
);

app.get('/logout', (req, res) => req.logout(() => res.redirect('/login')));

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ── Authenticated API routes ──────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'not authenticated' });
  next();
}

app.get('/me', requireAuth, (req, res) => {
  const sess = live.get(req.user.email);
  res.json({ email: req.user.email, name: req.user.name, avatar: req.user.avatar, hasSession: !!sess, isAdmin: getAdmins().includes(req.user.email), isSuperAdmin: req.user.email === SUPER_ADMIN });
});

// List project directories for the current user (personal + shared)
app.get('/api/projects', requireAuth, (req, res) => {
  const email    = req.user.email;
  const username = email.split('@')[0];
  const base     = path.join(getProjectsBase(), username);

  let personal = [];
  try {
    if (fs.existsSync(base)) {
      personal = fs.readdirSync(base, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => {
          const fullPath = path.join(base, e.name);
          return { name: e.name, path: fullPath, mtime: fs.statSync(fullPath).mtimeMs, shared: false };
        });
    }
  } catch (_) {}

  const shared = getAccessibleSharedProjects(email)
    .filter(p => { try { return fs.existsSync(p.path); } catch (_) { return false; } })
    .map(p => {
      const name = p.name || path.basename(p.path);
      return { name, path: p.path, mtime: fs.statSync(p.path).mtimeMs, shared: true };
    });

  res.json([...personal, ...shared].sort((a, b) => b.mtime - a.mtime));
});

// Session history CRUD
app.get('/api/sessions', requireAuth, (req, res) => {
  res.json(loadSessionHistory(req.user.email));
});

app.delete('/api/sessions', requireAuth, (req, res) => {
  const email = req.user.email;
  const list  = loadSessionHistory(email);
  // Delete all non-shared project directories
  list.forEach(s => {
    if (s.workDir && !isSharedProjectPath(s.workDir))
      fs.rm(s.workDir, { recursive: true, force: true }, () => {});
  });
  saveSessionHistory(email, []);
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  const email = req.user.email;
  const list  = loadSessionHistory(email);
  const entry = list.find(s => s.id === req.params.id);
  saveSessionHistory(email, list.filter(s => s.id !== req.params.id));
  // Remove the project directory, but never delete shared project folders
  const dir = entry?.workDir;
  if (dir && !isSharedProjectPath(dir)) fs.rm(dir, { recursive: true, force: true }, () => {});
  res.json({ ok: true });
});

// Save current active session metadata to history (no restart)
app.post('/api/sessions/save', requireAuth, (req, res) => {
  const email = req.user.email;
  const sess  = live.get(email);
  if (!sess) return res.status(400).json({ error: 'no active session' });

  const { title: autoTitle, snippet } = extractTitleAndSnippet(sess.buffer);
  const title = req.body?.title?.trim() || autoTitle || `Session ${new Date().toLocaleString()}`;

  pushToHistory(email, {
    id:        sess.sessionId,
    title,
    snippet:   snippet || '',
    timestamp: new Date().toISOString(),
    workDir:   sess.workDir,
  });

  res.json({ ok: true, id: sess.sessionId, title });
});

// Rename a saved session
app.patch('/api/sessions/:id', requireAuth, (req, res) => {
  const email = req.user.email;
  const title = req.body?.title?.trim();
  if (!title) return res.status(400).json({ error: 'title required' });

  const history = loadSessionHistory(email);
  const entry   = history.find(s => s.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });

  entry.title = title;
  saveSessionHistory(email, history);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/resume', requireAuth, (req, res) => {
  const email     = req.user.email;
  const sessionId = req.params.id;
  const history   = loadSessionHistory(email);
  const entry     = history.find(s => s.id === sessionId);
  if (!entry) return res.status(404).json({ error: 'not found' });

  const clients = live.get(email)?.clients ?? new Set();
  killSession(email);
  const newSess = startSession(req.user, sessionId, { workDir: entry.workDir });
  clients.forEach(c => newSess.clients.add(c));
  broadcast(email, { type: 'meta', restarted: true, resumed: true, sessionId });
  res.json({ ok: true });
});

// PTY control
app.post('/session/reset', requireAuth, (req, res) => {
  const email    = req.user.email;
  const { projectName, workDir: explicitWorkDir } = req.body || {};
  if (explicitWorkDir && !isAuthorizedWorkDir(email, explicitWorkDir)) {
    return res.status(403).json({ error: 'not authorized' });
  }
  const clients = live.get(email)?.clients ?? new Set();
  killSession(email);
  const id      = newId();
  const newSess = startSession(req.user, id,
    explicitWorkDir ? { workDir: explicitWorkDir } : { projectName }
  );
  clients.forEach(c => newSess.clients.add(c));
  broadcast(email, { type: 'meta', restarted: true, resumed: false, workDir: newSess.workDir });
  res.json({ ok: true });
});

app.post('/session/refresh', requireAuth, (req, res) => {
  const email = req.user.email;
  const sess  = live.get(email);
  if (!sess) return res.json({ ok: true });

  const savedSessionId = sess.sessionId;
  const savedWorkDir   = sess.workDir;
  // Snapshot the buffer now — before compact output contaminates it — for a meaningful title
  const preCompactBuffer = sess.buffer;
  const SETTLE_MS  = 500;
  const TIMEOUT_MS = 20000;

  let done = false;
  let settleTimer, hardTimer;

  function doRestart() {
    if (done) return;
    done = true;
    clearTimeout(settleTimer);
    clearTimeout(hardTimer);
    onDataDisposable.dispose();

    const { title, snippet } = extractTitleAndSnippet(preCompactBuffer);

    pushToHistory(email, {
      id:        savedSessionId,
      title:     title || `Session ${new Date().toLocaleString()}`,
      snippet:   snippet || '',
      timestamp: new Date().toISOString(),
      workDir:   savedWorkDir,
    });

    const clients = new Set(sess.clients);
    killSession(email);
    const id      = newId();
    // Resume in the same project directory after refresh
    const newSess = startSession(req.user, id, { workDir: savedWorkDir });
    clients.forEach(c => newSess.clients.add(c));
    broadcast(email, { type: 'meta', restarted: true, resumed: false, workDir: newSess.workDir });
    res.json({ ok: true });
  }

  sess.ptyProcess.write('/compact\r');
  const onDataDisposable = sess.ptyProcess.onData(() => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(doRestart, SETTLE_MS);
  });
  hardTimer = setTimeout(doRestart, TIMEOUT_MS);
});

// ── File browser ─────────────────────────────────────────────────────────────

app.get('/api/filetree', requireAuth, (req, res) => {
  const email   = req.user.email;
  const dir     = req.query.path;
  if (!dir) return res.status(400).json({ error: 'path required' });
  const resolved = path.resolve(dir);
  if (!isAuthorizedPath(email, resolved)) return res.status(403).json({ error: 'not authorized' });
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', path: path.join(resolved, e.name) }));
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const DEFAULT_FILE_READ_LIMIT_MB = 5;
function getFileReadLimit() {
  const mb = getSettings().fileReadLimitMb;
  return (typeof mb === 'number' && mb > 0 ? mb : DEFAULT_FILE_READ_LIMIT_MB) * 1024 * 1024;
}
app.get('/api/file', requireAuth, (req, res) => {
  const email    = req.user.email;
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const resolved = path.resolve(filePath);
  if (!isAuthorizedPath(email, resolved)) return res.status(403).json({ error: 'not authorized' });
  try {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) return res.status(400).json({ error: 'is a directory' });
    const limit     = getFileReadLimit();
    const size      = stat.size;
    const readSize  = Math.min(size, limit);
    const buf       = Buffer.alloc(readSize);
    const fd        = fs.openSync(resolved, 'r');
    fs.readSync(fd, buf, 0, readSize, 0);
    fs.closeSync(fd);
    res.json({ content: buf.toString('utf8'), size, truncated: size > limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin routes ─────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const isJson = req.xhr || (req.headers.accept || '').includes('application/json');
  if (!req.isAuthenticated()) {
    return isJson ? res.status(401).json({ error: 'not authenticated' }) : res.redirect('/login');
  }
  if (!getAdmins().includes(req.user.email)) {
    return isJson ? res.status(403).json({ error: 'forbidden' }) : res.redirect('/');
  }
  next();
}

// Serve admin page (outside public/ so it's never served statically)
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Whitelist management
app.get('/admin/api/whitelist', requireAdmin, (req, res) => {
  res.json(getWhitelist());
});
app.post('/admin/api/whitelist', requireAdmin, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const list = getWhitelist();
  if (list.includes(email)) return res.status(409).json({ error: 'already in whitelist' });
  list.push(email);
  saveWhitelist(list);
  res.json({ ok: true });
});
app.delete('/admin/api/whitelist/:email', requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params.email);
  saveWhitelist(getWhitelist().filter(e => e !== email));
  res.json({ ok: true });
});

// Shared projects management
app.get('/admin/api/shared-projects', requireAdmin, (req, res) => {
  res.json(getSharedProjects());
});
app.post('/admin/api/shared-projects', requireAdmin, (req, res) => {
  const { path: p, name, users } = req.body;
  if (!p) return res.status(400).json({ error: 'path required' });
  const list = getSharedProjects();
  list.push({ id: newId(), path: p.trim(), name: (name || '').trim() || undefined, users: Array.isArray(users) ? users : [] });
  saveSharedProjects(list);
  res.json({ ok: true });
});
app.put('/admin/api/shared-projects/:id', requireAdmin, (req, res) => {
  const list = getSharedProjects();
  const idx  = list.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const { path: p, name, users } = req.body;
  if (!p) return res.status(400).json({ error: 'path required' });
  list[idx] = { ...list[idx], path: p.trim(), name: (name || '').trim() || undefined, users: Array.isArray(users) ? users : [] };
  saveSharedProjects(list);
  res.json({ ok: true });
});
app.delete('/admin/api/shared-projects/:id', requireAdmin, (req, res) => {
  const list = getSharedProjects();
  const idx  = list.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  list.splice(idx, 1);
  saveSharedProjects(list);
  res.json({ ok: true });
});

// Admin users management (super admin only)
app.get('/admin/api/admins', requireAdmin, (req, res) => {
  res.json({ admins: getAdmins(), superAdmin: SUPER_ADMIN });
});
app.post('/admin/api/admins', requireAdmin, (req, res) => {
  if (req.user.email !== SUPER_ADMIN) return res.status(403).json({ error: 'forbidden' });
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ error: 'email required' });
  const list = getAdmins();
  if (list.includes(email)) return res.status(409).json({ error: 'already an admin' });
  list.push(email);
  saveAdmins(list);
  res.json({ ok: true });
});
app.delete('/admin/api/admins/:email', requireAdmin, (req, res) => {
  if (req.user.email !== SUPER_ADMIN) return res.status(403).json({ error: 'forbidden' });
  const email = decodeURIComponent(req.params.email);
  if (email === SUPER_ADMIN) return res.status(403).json({ error: 'cannot remove super admin' });
  saveAdmins(getAdmins().filter(e => e !== email));
  res.json({ ok: true });
});

// Settings (super admin only)

// Recursively copy a directory (fallback for cross-device moves).
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Move all user project directories and update their metadata to point at newBase.
// Returns an array of error strings (empty = full success).
function migrateProjectsBase(oldBase, newBase) {
  const oldResolved = path.resolve(oldBase);
  const newResolved = path.resolve(newBase);
  if (oldResolved === newResolved) return [];

  const errors = [];
  const moved  = new Map(); // oldAbsPath → newAbsPath, avoids double-moving

  function remapPath(workDir) {
    if (!workDir) return null;
    const abs = path.resolve(workDir);
    if (!abs.startsWith(oldResolved + path.sep)) return null;
    return path.join(newResolved, path.relative(oldResolved, abs));
  }

  function moveDir(oldPath, newPath) {
    if (moved.has(oldPath)) return moved.get(oldPath);
    const result = (() => {
      if (!fs.existsSync(oldPath)) return newPath; // gone already — just remap the reference
      try {
        fs.mkdirSync(path.dirname(newPath), { recursive: true });
        fs.renameSync(oldPath, newPath);
        return newPath;
      } catch (e) {
        if (e.code !== 'EXDEV') { errors.push(`move ${oldPath}: ${e.message}`); return null; }
        // Cross-device: copy then delete
        try {
          copyDirSync(oldPath, newPath);
          fs.rmSync(oldPath, { recursive: true, force: true });
          return newPath;
        } catch (e2) { errors.push(`copy ${oldPath}: ${e2.message}`); return null; }
      }
    })();
    moved.set(oldPath, result);
    return result;
  }

  const usersDir = path.join(__dirname, 'users');
  if (!fs.existsSync(usersDir)) return errors;

  for (const entry of fs.readdirSync(usersDir, { withFileTypes: true }).filter(e => e.isDirectory())) {
    const userDir     = path.join(usersDir, entry.name);
    const sessFile    = path.join(userDir, 'sessions.json');
    const activeFile  = path.join(userDir, 'active.json');

    // sessions.json
    let sessions = [];
    try { sessions = JSON.parse(fs.readFileSync(sessFile, 'utf8')); } catch (_) { continue; }
    let changed = false;
    sessions = sessions.map(s => {
      const newWorkDir = remapPath(s.workDir);
      if (!newWorkDir) return s;
      const result = moveDir(path.resolve(s.workDir), newWorkDir);
      if (!result) return s;
      changed = true;
      return { ...s, workDir: result };
    });
    if (changed) {
      try { fs.writeFileSync(sessFile, JSON.stringify(sessions, null, 2)); }
      catch (e) { errors.push(`write sessions/${entry.name}: ${e.message}`); }
    }

    // active.json
    try {
      const active = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
      const newWorkDir = remapPath(active?.workDir);
      if (newWorkDir) {
        const result = moveDir(path.resolve(active.workDir), newWorkDir);
        if (result) {
          active.workDir = result;
          fs.writeFileSync(activeFile, JSON.stringify(active, null, 2));
        }
      }
    } catch (_) {}
  }

  // Update any currently live in-memory sessions
  for (const [, sess] of live) {
    const newWorkDir = remapPath(sess.workDir);
    if (newWorkDir) sess.workDir = newWorkDir;
  }

  return errors;
}

app.get('/admin/api/settings', requireAdmin, (req, res) => {
  const s = getSettings();
  const h  = s.idleTimeoutHours;
  const mb = s.fileReadLimitMb;
  const kb = s.outputBufferKb;
  res.json({
    projectsBase:     getProjectsBase(),
    idleTimeoutHours: typeof h  === 'number' && h  > 0 ? h  : DEFAULT_IDLE_TIMEOUT_HOURS,
    fileReadLimitMb:  typeof mb === 'number' && mb > 0 ? mb : DEFAULT_FILE_READ_LIMIT_MB,
    outputBufferKb:   typeof kb === 'number' && kb > 0 ? kb : DEFAULT_OUTPUT_BUFFER_KB,
  });
});
app.put('/admin/api/settings', requireAdmin, (req, res) => {
  if (req.user.email !== SUPER_ADMIN) return res.status(403).json({ error: 'forbidden' });
  const { projectsBase, idleTimeoutHours, fileReadLimitMb, outputBufferKb } = req.body;
  const current  = getSettings();
  const updated  = { ...current };
  const response = {};

  if (projectsBase !== undefined) {
    if (typeof projectsBase !== 'string') return res.status(400).json({ error: 'projectsBase must be a string' });
    const trimmed  = projectsBase.trim();
    const resolved = trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
    if (!path.isAbsolute(resolved)) return res.status(400).json({ error: 'projectsBase must be an absolute path (or start with ~)' });
    const oldBase = getProjectsBase();
    updated.projectsBase = trimmed;
    saveSettings(updated);
    const newBase = getProjectsBase();
    const warnings = migrateProjectsBase(oldBase, newBase);
    response.projectsBase = newBase;
    if (warnings.length) response.warnings = warnings;
  }

  if (idleTimeoutHours !== undefined) {
    const h = Number(idleTimeoutHours);
    if (!Number.isFinite(h) || h <= 0) return res.status(400).json({ error: 'idleTimeoutHours must be a positive number' });
    updated.idleTimeoutHours = h;
    saveSettings(updated);
    response.idleTimeoutHours = h;
  }

  if (fileReadLimitMb !== undefined) {
    const mb = Number(fileReadLimitMb);
    if (!Number.isFinite(mb) || mb <= 0) return res.status(400).json({ error: 'fileReadLimitMb must be a positive number' });
    updated.fileReadLimitMb = mb;
    saveSettings(updated);
    response.fileReadLimitMb = mb;
  }

  if (outputBufferKb !== undefined) {
    const kb = Number(outputBufferKb);
    if (!Number.isFinite(kb) || kb <= 0) return res.status(400).json({ error: 'outputBufferKb must be a positive number' });
    updated.outputBufferKb = kb;
    saveSettings(updated);
    response.outputBufferKb = kb;
  }

  res.json({ ok: true, ...response });
});

// Active sessions (view + kill)
app.get('/admin/api/active-sessions', requireAdmin, (req, res) => {
  const sessions = [];
  for (const [email, sess] of live) {
    sessions.push({
      email,
      sessionId: sess.sessionId,
      workDir:   sess.workDir,
      clients:   sess.clients.size,
    });
  }
  res.json(sessions);
});
app.delete('/admin/api/active-sessions/:email', requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params.email);
  killSession(email);
  res.json({ ok: true });
});

// ── Static files (auth-guarded) ───────────────────────────────────────────────

app.use((req, res, next) => {
  if (!req.isAuthenticated()) return res.redirect('/login');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket ─────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  sessionParser(request, {}, () => {
    const user = request.session?.passport?.user;
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    request.user = user;
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
});

wss.on('connection', (ws, request) => {
  const user  = request.user;
  const email = user.email;
  let isResumed = false;
  let sess = live.get(email);

  if (sess) {
    // Reconnect to existing live session
    isResumed = true;
    clearTimeout(sess.killTimer);
    sess.killTimer = null;
    if (sess.buffer) ws.send(JSON.stringify({ type: 'output', data: sess.buffer }));
    if (sess.chatLog.length) ws.send(JSON.stringify({ type: 'chat_log', entries: sess.chatLog }));
    sess.clients.add(ws);
  } else {
    // Check for persisted active session
    const active   = loadActive(email);
    const canResume = active?.sessionId && active?.workDir && fs.existsSync(active.workDir);
    const sessionId = canResume ? active.sessionId : newId();
    isResumed = canResume;
    sess = startSession(user, sessionId, canResume ? { workDir: active.workDir } : {});
    sess.clients.add(ws);
  }

  ws.send(JSON.stringify({ type: 'meta', resumed: isResumed, sessionId: sess.sessionId, workDir: sess.workDir }));
  console.log(`[${email}] connected (${isResumed ? 'resumed' : 'new'} session ${sess.sessionId} @ ${sess.workDir})`);

  ws.on('message', (raw) => {
    try {
      const msg     = JSON.parse(raw);
      const current = live.get(email);
      if (!current) return;
      if (msg.type === 'input')  current.ptyProcess.write(msg.data);
      if (msg.type === 'input') {
        const text = msg.data.replace(/\r?\n$/, '').trim();
        if (text) {
          current.chatLog.push({ role: 'user', text });
          clearTimeout(current.chatSettleTimer);
          const chatMsg = JSON.stringify({ type: 'chat_user', text });
          current.clients.forEach(c => { if (c.readyState === c.OPEN && c !== ws) c.send(chatMsg); });
        }
      }
      if (msg.type === 'resize') current.ptyProcess.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
    } catch (_) {}
  });

  ws.on('close', () => {
    const current = live.get(email);
    if (!current) return;
    current.clients.delete(ws);
    if (current.clients.size === 0) {
      current.killTimer = setTimeout(() => {
        console.log(`[${email}] idle timeout`);
        killSession(email);
      }, getIdleTimeoutMs());
      console.log(`[${email}] disconnected (session kept ${getIdleTimeoutMs() / 60000}min)`);
    }
  });
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[${signal}] shutting down — killing ${live.size} live session(s)…`);
  for (const [email] of live) killSession(email);
  server.close(() => process.exit(0));
  // Force-exit if server.close stalls
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));
process.on('exit',    () => { for (const [email] of live) killSession(email); });

server.listen(PORT, () => console.log(`Claude Code Web Terminal → ${BASE_URL}`));
