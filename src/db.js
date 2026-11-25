import { TIMEOUT_CLOSED_NOTIFICATION } from "./messages.js";

let schemaReady = false;

export async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        created_by INTEGER,
        used_by INTEGER,
        created_at INTEGER NOT NULL,
        used_at INTEGER
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_token TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        status TEXT NOT NULL,
        close_reason TEXT,
        can_reply INTEGER NOT NULL DEFAULT 0,
        is_generating INTEGER NOT NULL DEFAULT 0,
        assigned_to INTEGER,
        assigned_username TEXT,
        pool_reason TEXT,
        waiting_since INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        sender TEXT NOT NULL,
        author_user_id INTEGER,
        author_name TEXT,
        text TEXT NOT NULL,
        is_survey_question INTEGER NOT NULL DEFAULT 0,
        survey_item_id INTEGER,
        delivered_to_ext INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS survey_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        question_text TEXT NOT NULL,
        ai_answer_text TEXT,
        asked_by_user_id INTEGER,
        asked_by_name TEXT,
        good_votes INTEGER NOT NULL DEFAULT 0,
        bad_votes INTEGER NOT NULL DEFAULT 0,
        in_standard INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS survey_votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        survey_item_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        vote INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(survey_item_id, user_id)
      )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`
    ),
    db.prepare(
      `INSERT OR IGNORE INTO system_settings (key, value) VALUES ('timeout_minutes', '30')`
    ),
    db.prepare(
      `INSERT OR IGNORE INTO system_settings (key, value) VALUES ('survey_trigger_threshold', '3')`
    ),
    db.prepare(
      `INSERT OR IGNORE INTO system_settings (key, value) VALUES ('survey_manual_open', '0')`
    )
  ]);
  schemaReady = true;
}

export async function getSetting(db, key, fallback) {
  const row = await db
    .prepare("SELECT value FROM system_settings WHERE key = ?")
    .bind(key)
    .first();
  return row ? row.value : fallback;
}

export async function setSetting(db, key, value) {
  await db
    .prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)")
    .bind(key, String(value))
    .run();
}

export async function expireTimedOutTickets(db) {
  const timeoutMin = Math.max(
    1,
    parseInt(await getSetting(db, "timeout_minutes", "30"), 10) || 30
  );
  const cutoff = Date.now() - timeoutMin * 60 * 1000;

  const { results: expired } = await db
    .prepare(
      `SELECT id FROM tickets
       WHERE waiting_since IS NOT NULL
         AND waiting_since <= ?
         AND (status = 'PENDING' OR (status IN ('ACTIVE', 'POOL') AND can_reply = 1))`
    )
    .bind(cutoff)
    .all();

  if (!expired || expired.length === 0) return 0;

  const now = Date.now();
  const stmts = [];
  for (const t of expired) {
    stmts.push(
      db
        .prepare(
          `UPDATE tickets
           SET status = 'CLOSED',
               close_reason = 'TIMEOUT',
               can_reply = 0,
               waiting_since = NULL,
               closed_at = ?,
               updated_at = ?
           WHERE id = ? AND status != 'CLOSED'`
        )
        .bind(now, now, t.id)
    );
    stmts.push(
      db
        .prepare(
          `INSERT INTO messages (ticket_id, sender, author_name, text, delivered_to_ext, created_at)
           VALUES (?, 'SYSTEM', 'СИСТЕМА', ?, 1, ?)`
        )
        .bind(
          t.id,
          `Тикет автоматически сброшен по таймауту (${timeoutMin} мин. без ответа поддержки).`,
          now
        )
    );
    stmts.push(
      db
        .prepare(
          `INSERT INTO messages (ticket_id, sender, author_name, text, delivered_to_ext, created_at)
           VALUES (?, 'SUPPORT', 'ТАЙМАУТ', ?, 0, ?)`
        )
        .bind(t.id, TIMEOUT_CLOSED_NOTIFICATION, now)
    );
  }
  await db.batch(stmts);
  return expired.length;
}

export async function buildSurveyState(db, userId) {
  const threshold = Math.max(
    1,
    parseInt(await getSetting(db, "survey_trigger_threshold", "3"), 10) || 3
  );
  const manualOpen = (await getSetting(db, "survey_manual_open", "0")) === "1";

  const { results: items } = await db
    .prepare(
      `SELECT s.*,
              (SELECT vote FROM survey_votes v WHERE v.survey_item_id = s.id AND v.user_id = ?) AS my_vote
       FROM survey_items s
       ORDER BY s.id DESC`
    )
    .bind(userId)
    .all();

  const answeredCount = items.filter(
    (x) => x.ai_answer_text && x.ai_answer_text.trim() !== ""
  ).length;

  const pollActive = manualOpen || answeredCount >= threshold;
  const standardQuestions = items
    .filter((x) => x.in_standard === 1 || x.good_votes > x.bad_votes)
    .sort((a, b) => b.good_votes - b.bad_votes || a.id - b.id);

  return {
    threshold,
    manualOpen,
    answeredCount,
    totalCount: items.length,
    pollActive,
    items,
    standardQuestions
  };
}

export async function handleExtStart(db, clientToken, chatKey) {
  const existing = await db
    .prepare(
      `SELECT * FROM tickets
       WHERE client_token = ? AND chat_key = ? AND status != 'CLOSED'
       ORDER BY id DESC LIMIT 1`
    )
    .bind(clientToken, chatKey)
    .first();

  if (existing) {
    return { ticket: existing, alreadyExists: true };
  }

  const now = Date.now();
  const res = await db
    .prepare(
      `INSERT INTO tickets (client_token, chat_key, status, can_reply, is_generating, waiting_since, created_at, updated_at)
       VALUES (?, ?, 'PENDING', 0, 0, ?, ?, ?)`
    )
    .bind(clientToken, chatKey, now, now, now)
    .run();

  const ticketId = res.meta.last_row_id;
  await db
    .prepare(
      `INSERT INTO messages (ticket_id, sender, author_name, text, delivered_to_ext, created_at)
       VALUES (?, 'SYSTEM', 'СИСТЕМА', ?, 1, ?)`
    )
    .bind(
      ticketId,
      `Тикет #${String(ticketId).padStart(4, "0")} зарегистрирован по команде start(support). Ожидает активации.`,
      now
    )
    .run();

  const ticket = await db
    .prepare("SELECT * FROM tickets WHERE id = ?")
    .bind(ticketId)
    .first();
  return { ticket, alreadyExists: false };
}

export async function handleExtSupportMessage(db, ticketId, text) {
  const ticket = await db
    .prepare("SELECT * FROM tickets WHERE id = ?")
    .bind(ticketId)
    .first();
  if (!ticket) return { ok: false, error: "Тикет не найден." };
  if (ticket.status !== "ACTIVE" && ticket.status !== "POOL") {
    return { ok: false, error: "Тикет не активен." };
  }

  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO messages (ticket_id, sender, author_name, text, delivered_to_ext, created_at)
       VALUES (?, 'GEMINI', 'GEMINI', ?, 1, ?)`
    )
    .bind(ticketId, text, now)
    .run();

  await db
    .prepare(
      `UPDATE tickets
       SET can_reply = 1, waiting_since = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(now, now, ticketId)
    .run();

  const { results: openSurveys } = await db
    .prepare(
      `SELECT id FROM survey_items
       WHERE ticket_id = ? AND (ai_answer_text IS NULL OR ai_answer_text = '')
       ORDER BY id ASC`
    )
    .bind(ticketId)
    .all();

  if (openSurveys && openSurveys.length > 0) {
    await db.batch(
      openSurveys.map((s) =>
        db
          .prepare(
            `UPDATE survey_items
             SET ai_answer_text = ?, answered_at = ?
             WHERE id = ?`
          )
          .bind(text, now, s.id)
      )
    );
  }

  return { ok: true };
}

export async function handleExtStop(db, ticketId) {
  const ticket = await db
    .prepare("SELECT * FROM tickets WHERE id = ?")
    .bind(ticketId)
    .first();
  if (!ticket || ticket.status === "CLOSED") return { ok: false };

  const now = Date.now();
  await db
    .prepare(
      `UPDATE tickets
       SET status = 'CLOSED', close_reason = 'GEMINI_STOP', can_reply = 0,
           is_generating = 0, waiting_since = NULL, closed_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(now, now, ticketId)
    .run();

  await db
    .prepare(
      `INSERT INTO messages (ticket_id, sender, author_name, text, delivered_to_ext, created_at)
       VALUES (?, 'SYSTEM', 'СИСТЕМА', 'Тикет закрыт по команде stop(support) со стороны Gemini.', 1, ?)`
    )
    .bind(ticketId, now)
    .run();

  return { ok: true };
}
