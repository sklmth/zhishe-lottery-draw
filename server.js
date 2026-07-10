'use strict';

const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
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
};

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

// ── POST /api/sessions ────────────────────────────────────────────────────────
app.post('/api/sessions', (req, res) => {
  const { draws, note } = req.body || {};
  if (!Array.isArray(draws) || draws.length === 0) {
    return res.status(400).json({ error: 'draws 数组不能为空' });
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
app.listen(PORT, () => {
  console.log(`幸运抽签系统已启动  http://localhost:${PORT}`);
  console.log(`数据库路径: ${DB_PATH}`);
});
