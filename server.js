const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SCORE_FILE = path.join(DATA_DIR, 'scores.json');

function ensureScoreStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SCORE_FILE)) fs.writeFileSync(SCORE_FILE, '[]', 'utf8');
}

function normalizeName(input) {
  if (typeof input !== 'string') return '';
  return input.trim().slice(0, 24);
}

function normalizePlayerId(input) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim().slice(0, 80);
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : '';
}

function readScores() {
  ensureScoreStore();
  try {
    const raw = fs.readFileSync(SCORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const now = Date.now();
    return parsed
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const playerId = normalizePlayerId(item.playerId);
        const name = normalizeName(item.name);
        const score = Number(item.score);
        const updatedAt = Number(item.updatedAt);
        if (!playerId || !name || !Number.isInteger(score) || score < 0) return null;
        return {
          playerId,
          name,
          score,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : now
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeScores(scores) {
  ensureScoreStore();
  fs.writeFileSync(SCORE_FILE, JSON.stringify(scores, null, 2), 'utf8');
}

function rankScores(scores) {
  const sorted = [...scores].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.updatedAt - b.updatedAt;
  });
  return sorted.map((item, index) => ({ ...item, rank: index + 1 }));
}

function upsertScore(playerId, name, score) {
  const all = readScores();
  const now = Date.now();
  const existing = all.find((item) => item.playerId === playerId);

  if (!existing) {
    all.push({ playerId, name, score, updatedAt: now });
  } else {
    existing.name = name;
    existing.updatedAt = now;
    if (score > existing.score) existing.score = score;
  }

  writeScores(all);
  return rankScores(all);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.webmanifest') return 'application/manifest+json; charset=utf-8';
  return 'application/octet-stream';
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function pickTop(ranked, limit = 50) {
  return ranked.slice(0, limit).map(({ name, score, rank }) => ({ name, score, rank }));
}

function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
    const ranked = rankScores(readScores());
    const playerId = normalizePlayerId(url.searchParams.get('playerId') || '');
    const me = playerId ? ranked.find((item) => item.playerId === playerId) : null;

    sendJson(res, 200, {
      me: me ? { name: me.name, score: me.score, rank: me.rank } : null,
      top: pickTop(ranked)
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/score') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        const payload = JSON.parse(raw || '{}');
        const playerId = normalizePlayerId(payload.playerId);
        const name = normalizeName(payload.name);
        const score = Number(payload.score);

        if (!playerId) {
          sendJson(res, 400, { error: 'playerId required' });
          return;
        }
        if (!name) {
          sendJson(res, 400, { error: 'nickname required' });
          return;
        }
        if (!Number.isInteger(score) || score < 0) {
          sendJson(res, 400, { error: 'invalid score' });
          return;
        }

        const ranked = upsertScore(playerId, name, score);
        const me = ranked.find((item) => item.playerId === playerId);
        sendJson(res, 200, {
          me: me ? { name: me.name, score: me.score, rank: me.rank } : null,
          top: pickTop(ranked)
        });
      } catch {
        sendJson(res, 400, { error: 'invalid json' });
      }
    });
    return true;
  }

  return false;
}

function safeFilePath(urlPath) {
  const raw = urlPath === '/' ? '/index.html' : urlPath;
  const clean = path.normalize(decodeURIComponent(raw)).replace(/^(\.\.[/\\])+/, '');
  const resolved = path.join(ROOT, clean);
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    if (handleApi(req, res, url)) return;
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const targetPath = safeFilePath(url.pathname);
  if (!targetPath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(targetPath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': getContentType(targetPath),
      'Cache-Control': targetPath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(targetPath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  ensureScoreStore();
  console.log(`Server running at http://${HOST}:${PORT}`);
});
