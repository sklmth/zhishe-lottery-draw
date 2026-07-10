'use strict';

const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'lottery.db');

// ── Database setup ────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    DATETIME DEFAULT (datetime('now','localtime')),
    total_members INTEGER  NOT NULL DEFAULT 12,
    note          TEXT
  );

  CREATE TABLE IF NOT EXISTS draws (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL,
    draw_order  INTEGER NOT NULL,
    member_name TEXT    NOT NULL,
    draw_number INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_draws_session ON draws(session_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_draws_session_number ON draws(session_id, draw_number);

  CREATE TABLE IF NOT EXISTS active_draws (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    draw_order  INTEGER NOT NULL UNIQUE,
    member_name TEXT    NOT NULL,
    draw_number INTEGER NOT NULL UNIQUE,
    created_at   DATETIME DEFAULT (datetime('now','localtime'))
  );
`);

// ── Prepared statements ───────────────────────────────────────────────────────
const stmts = {
  insertSession: db.prepare(
    'INSERT INTO sessions (total_members, note) VALUES (?, ?)'
  ),
  insertDraw: db.prepare(
    'INSERT INTO draws (session_id, draw_order, member_name, draw_number) VALUES (?, ?, ?, ?)'
  ),
  listSessions: db.prepare(`
    SELECT id, created_at, total_members, note
    FROM sessions
    ORDER BY created_at DESC
    LIMIT 50
  `),
  countSessions: db.prepare('SELECT COUNT(*) AS cnt FROM sessions'),
  getSession:    db.prepare('SELECT * FROM sessions WHERE id = ?'),
  getDraws:      db.prepare(
    'SELECT draw_order, member_name, draw_number FROM draws WHERE session_id = ? ORDER BY draw_order'
  ),
  listActiveDraws: db.prepare(
    'SELECT draw_order, member_name, draw_number FROM active_draws ORDER BY draw_order'
  ),
  countActiveDraws: db.prepare('SELECT COUNT(*) AS cnt FROM active_draws'),
  insertActiveDraw: db.prepare(
    'INSERT INTO active_draws (draw_order, member_name, draw_number) VALUES (?, ?, ?)'
  ),
  clearActiveDraws: db.prepare('DELETE FROM active_draws'),
};

const liveState = {
  status: 'idle',
  spinner: null,
  startedAt: null,
};

function getActiveCount() {
  return stmts.countActiveDraws.get().cnt;
}

function normalizeLiveState() {
  if (liveState.status === 'spinning' && liveState.startedAt && Date.now() - liveState.startedAt > 15000) {
    liveState.status = 'idle';
    liveState.spinner = null;
    liveState.startedAt = null;
  }
  return {
    status: liveState.status,
    spinner: liveState.spinner,
    startedAt: liveState.startedAt,
  };
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (_req, res) => {
  const idx = path.join(__dirname, 'index.html');
  res.sendFile(
    fs.existsSync(idx) ? idx : path.join(__dirname, 'lottery_wheel (2).html')
  );
});

function activePayload() {
  const draws = stmts.listActiveDraws.all();
  return {
    total: draws.length,
    remaining: Math.max(0, 12 - draws.length),
    state: normalizeLiveState(),
    draws,
  };
}

function persistCompletedActiveSession() {
  const active = stmts.listActiveDraws.all();
  if (active.length !== 12) return null;

  const { lastInsertRowid: sessionId } = stmts.insertSession.run(
    active.length,
    '服务器实时抽签自动保存'
  );
  for (const d of active) {
    stmts.insertDraw.run(sessionId, d.draw_order, d.member_name, d.draw_number);
  }
  return stmts.getSession.get(sessionId);
}

// ── Server-side live draw state ───────────────────────────────────────────────
app.get('/api/current-draw', (_req, res) => {
  try {
    res.json(activePayload());
  } catch (err) {
    console.error('查询实时抽签状态失败:', err);
    res.status(500).json({ error: '查询失败' });
  }
});

app.post('/api/current-draw/reset', (_req, res) => {
  try {
    const force = Boolean(_req.body && _req.body.force);
    const cnt = getActiveCount();
    if (cnt > 0 && cnt < 12 && !force) {
      return res.status(409).json({ error: '当前轮次正在进行，不能重置', ...activePayload() });
    }
    liveState.status = 'idle';
    liveState.spinner = null;
    liveState.startedAt = null;
    stmts.clearActiveDraws.run();
    res.json({ success: true, ...activePayload() });
  } catch (err) {
    console.error('重置实时抽签失败:', err);
    res.status(500).json({ error: '重置失败' });
  }
});

app.post('/api/current-draw/spin', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: '姓名不能为空' });

  try {
    db.exec('BEGIN IMMEDIATE');
    const current = stmts.listActiveDraws.all();
    if (current.length >= 12) {
      db.exec('COMMIT');
      return res.status(409).json({ error: '本轮 12 个号码已全部抽完', ...activePayload() });
    }

    const used = new Set(current.map(d => d.draw_number));
    const available = [];
    for (let i = 1; i <= 12; i++) if (!used.has(i)) available.push(i);
    const drawNumber = available[Math.floor(Math.random() * available.length)];
    const drawOrder = current.length;

    stmts.insertActiveDraw.run(drawOrder, name, drawNumber);
    liveState.status = 'spinning';
    liveState.spinner = name;
    liveState.startedAt = Date.now();
    const draw = { draw_order: drawOrder, member_name: name, draw_number: drawNumber };
    const shouldComplete = drawOrder === 11;
    let completedSession = null;
    if (shouldComplete) {
      completedSession = persistCompletedActiveSession();
      liveState.status = 'idle';
      liveState.spinner = null;
      liveState.startedAt = null;
      stmts.clearActiveDraws.run();
    }
    db.exec('COMMIT');

    res.status(201).json({ success: true, draw, completed: shouldComplete, session: completedSession, ...activePayload() });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('服务器分配抽签号码失败:', err);
    res.status(500).json({ error: '抽签失败' });
  }
});

app.post('/api/current-draw/complete-spin', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  normalizeLiveState();
  if (liveState.status === 'spinning' && (!name || liveState.spinner === name)) {
    liveState.status = 'idle';
    liveState.spinner = null;
    liveState.startedAt = null;
  }
  res.json({ success: true, ...activePayload() });
});

// ── POST /api/sessions ────────────────────────────────────────────────────────
app.post('/api/sessions', (req, res) => {
  const { draws, note } = req.body || {};
  if (!Array.isArray(draws) || draws.length === 0) {
    return res.status(400).json({ error: 'draws 数组不能为空' });
  }
  const seen = new Set();
  for (const d of draws) {
    const num = Number(d && d.number);
    if (!Number.isInteger(num) || num < 1 || num > 12) {
      return res.status(400).json({ error: '抽签号码必须是 1-12 的整数' });
    }
    if (seen.has(num)) {
      return res.status(400).json({ error: '同一轮抽签不能出现重复号码' });
    }
    seen.add(num);
  }

  try {
    db.exec('BEGIN');
    const { lastInsertRowid: sessionId } = stmts.insertSession.run(
      draws.length,
      note || null
    );
    for (const d of draws) {
      stmts.insertDraw.run(sessionId, d.order, d.name, d.number);
    }
    db.exec('COMMIT');

    const session = stmts.getSession.get(sessionId);
    res.status(201).json({ success: true, session });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('保存抽签记录失败:', err);
    res.status(500).json({ error: '保存失败' });
  }
});

// ── GET /api/sessions ─────────────────────────────────────────────────────────
app.get('/api/sessions', (_req, res) => {
  try {
    const sessions = stmts.listSessions.all();
    const result = sessions.map(s => ({
      ...s,
      draws: stmts.getDraws.all(s.id),
    }));
    const { cnt: total } = stmts.countSessions.get();
    res.json({ total, sessions: result });
  } catch (err) {
    console.error('查询历史记录失败:', err);
    res.status(500).json({ error: '查询失败' });
  }
});

// ── GET /api/sessions/:id ─────────────────────────────────────────────────────
app.get('/api/sessions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '无效 ID' });

  const session = stmts.getSession.get(id);
  if (!session) return res.status(404).json({ error: '记录不存在' });

  res.json({ session, draws: stmts.getDraws.all(id) });
});

// ── DELETE /api/sessions/:id ──────────────────────────────────────────────────
app.delete('/api/sessions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: '无效 ID' });

  const { changes } = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  if (changes === 0) return res.status(404).json({ error: '记录不存在' });

  res.json({ success: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`幸运抽签系统已启动  http://${HOST}:${PORT}`);
  console.log(`数据库路径: ${DB_PATH}`);
});
