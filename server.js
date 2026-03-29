require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const OUTPUT_BUFFER_SIZE = 200_000;
const MAX_SESSIONS = 100;

// ── Whitelist ─────────────────────────────────────────────────────────────────

const whitelistPath = path.join(__dirname, 'whitelist.json');
if (!fs.existsSync(whitelistPath)) fs.writeFileSync(whitelistPath, '[]');
function getWhitelist() {
  return JSON.parse(fs.readFileSync(whitelistPath, 'utf8'));
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

function newId() { return crypto.randomBytes(6).toString('hex'); }

function userDataDir(email) {
  return path.join(__dirname, 'users', email.replace(/[^a-zA-Z0-9._-]/g, '_'));
}

function sessionsFilePath(email)  { return path.join(userDataDir(email), 'sessions.json'); }
function activeFilePath(email)    { return path.join(userDataDir(email), 'active.json'); }

// ── Project directory helpers ─────────────────────────────────────────────────

function sanitizeDir(name) {
  return (name || '').trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 64) || null;
}

// ~/Documents/Claude_Projects/{username}/{project_name_or_id}
function resolveWorkDir(email, id, projectName) {
  const username = email.split('@')[0];
  const base     = path.join(os.homedir(), 'Documents', 'Claude_Projects', username);
  const safeName = sanitizeDir(projectName);
  if (!safeName) return path.join(base, id);

  // Find a non-conflicting directory name
  let dir = path.join(base, safeName);
  let n = 2;
  while (fs.existsSync(dir)) {
    dir = path.join(base, `${safeName}-${n++}`);
  }
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

  const ptyProcess = pty.spawn('claude', [], {
    name: 'xterm-256color', cols: 220, rows: 50, cwd: workDir, env: process.env,
  });

  const sess = { ptyProcess, buffer: '', clients: new Set(), killTimer: null, sessionId, workDir };
  live.set(email, sess);
  saveActive(email, sessionId, workDir);

  ptyProcess.onData((data) => {
    sess.buffer += data;
    if (sess.buffer.length > OUTPUT_BUFFER_SIZE) sess.buffer = sess.buffer.slice(-OUTPUT_BUFFER_SIZE);
    const msg = JSON.stringify({ type: 'output', data });
    sess.clients.forEach(c => { if (c.readyState === c.OPEN) c.send(msg); });
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[${email}] exited (${exitCode})`);
    const msg = JSON.stringify({ type: 'exit', code: exitCode });
    sess.clients.forEach(c => { if (c.readyState === c.OPEN) { c.send(msg); c.close(); } });
    live.delete(email);
  });

  return sess;
}

function killSession(email) {
  const sess = live.get(email);
  if (!sess) return;
  clearTimeout(sess.killTimer);
  try { sess.ptyProcess.kill(); } catch (_) {}
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
  passport.authenticate('google', { failureRedirect: '/login?error=not_whitelisted' }),
  (req, res) => res.redirect('/')
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
  res.json({ email: req.user.email, name: req.user.name, avatar: req.user.avatar, hasSession: !!sess });
});

// List project directories for the current user
app.get('/api/projects', requireAuth, (req, res) => {
  const username = req.user.email.split('@')[0];
  const base     = path.join(os.homedir(), 'Documents', 'Claude_Projects', username);
  try {
    if (!fs.existsSync(base)) return res.json([]);
    const entries = fs.readdirSync(base, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const fullPath = path.join(base, e.name);
        return { name: e.name, path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json(entries);
  } catch (_) { res.json([]); }
});

// Session history CRUD
app.get('/api/sessions', requireAuth, (req, res) => {
  res.json(loadSessionHistory(req.user.email));
});

app.delete('/api/sessions', requireAuth, (req, res) => {
  saveSessionHistory(req.user.email, []);
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', requireAuth, (req, res) => {
  const email   = req.user.email;
  const list    = loadSessionHistory(email);
  const entry   = list.find(s => s.id === req.params.id);
  saveSessionHistory(email, list.filter(s => s.id !== req.params.id));
  // Remove the project directory
  const dir = entry?.workDir;
  if (dir) fs.rm(dir, { recursive: true, force: true }, () => {});
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
  const email                        = req.user.email;
  const { projectName, workDir: explicitWorkDir } = req.body || {};
  const clients                      = live.get(email)?.clients ?? new Set();
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
  if (!sess) { return res.json({ ok: true }); }

  const savedSessionId  = sess.sessionId;
  const savedWorkDir    = sess.workDir;
  const bufferLenBefore = sess.buffer.length;
  const SETTLE_MS       = 500;
  const TIMEOUT_MS      = 20000;

  let done = false;
  let settleTimer, hardTimer;

  function doRestart() {
    if (done) return;
    done = true;
    clearTimeout(settleTimer);
    clearTimeout(hardTimer);

    // Extract title/snippet from compact output tail
    const tail = sess.buffer.slice(bufferLenBefore);
    const { title, snippet } = extractTitleAndSnippet(tail);

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
    const newSess = startSession(req.user, id);
    clients.forEach(c => newSess.clients.add(c));
    broadcast(email, { type: 'meta', restarted: true, resumed: false, workDir: newSess.workDir });
    res.json({ ok: true });
  }

  sess.ptyProcess.write('/compact\r');
  sess.ptyProcess.onData(() => {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(doRestart, SETTLE_MS);
  });
  hardTimer = setTimeout(doRestart, TIMEOUT_MS);
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
    sess.clients.add(ws);
  } else {
    // Check for persisted active session
    const active = loadActive(email);
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
      const msg      = JSON.parse(raw);
      const current  = live.get(email);
      if (!current) return;
      if (msg.type === 'input')  current.ptyProcess.write(msg.data);
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
      }, IDLE_TIMEOUT_MS);
      console.log(`[${email}] disconnected (session kept ${IDLE_TIMEOUT_MS / 60000}min)`);
    }
  });
});

server.listen(PORT, () => console.log(`Claude Code Web Terminal → ${BASE_URL}`));
