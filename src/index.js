import {
  STARTING_INSTRUCTION_MESSAGE,
  OPERATOR_CLOSED_NOTIFICATION
} from "./messages.js";
import {
  bufToHex,
  hashPassword,
  verifyPassword,
  signSessionToken,
  makeSessionCookie,
  getAuthUser
} from "./auth.js";
import {
  ensureSchema,
  getSetting,
  setSetting,
  expireTimedOutTickets,
  buildSurveyState,
  handleExtStart,
  handleExtSupportMessage,
  handleExtStop
} from "./db.js";

function jsonRes(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

export default {
  async scheduled(_event, env) {
    if (!env.DB) return;
    await ensureSchema(env.DB);
    await expireTimedOutTickets(env.DB);
  },

  async fetch(req, env) {
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method.toUpperCase();

      if (!path.startsWith("/api/")) {
        if (env.ASSETS) return env.ASSETS.fetch(req);
        return new Response("Not Found", { status: 404 });
      }

      if (!env.DB) {
        return jsonRes(
          { ok: false, error: "В Cloudflare не привязана база D1 с именем DB." },
          500
        );
      }

      await ensureSchema(env.DB);

      if (path.startsWith("/api/auth/") || path.startsWith("/api/panel/")) {
        if (!env.SESSION_SECRET) {
          return jsonRes(
            { ok: false, error: "В Variables and Secrets не задан секрет SESSION_SECRET." },
            500
          );
        }
      }

      // --- AUTH ---
      if (method === "GET" && path === "/api/auth/me") {
        const cntRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first();
        const needsSetup = !cntRow || cntRow.c === 0;
        const user = needsSetup ? null : await getAuthUser(req, env);
        return jsonRes({ ok: true, needsSetup, user });
      }

      if (method === "POST" && path === "/api/auth/setup") {
        const cntRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first();
        if (cntRow && cntRow.c > 0) {
          return jsonRes({ ok: false, error: "Система уже инициализирована." }, 403);
        }
        if (!env.SETUP_KEY) {
          return jsonRes(
            { ok: false, error: "В настройках Worker не задан SETUP_KEY." },
            500
          );
        }
        const body = await readJson(req);
        if (!body) return jsonRes({ ok: false, error: "Некорректный JSON." }, 400);

        if (String(body.setupKey || "") !== String(env.SETUP_KEY)) {
          return jsonRes({ ok: false, error: "Неверный SETUP_KEY." }, 403);
        }

        const username = String(body.username || "").trim();
        const password = String(body.password || "");
        if (username.length < 3 || password.length < 6) {
          return jsonRes(
            { ok: false, error: "Логин от 3 символов, пароль от 6 символов." },
            400
          );
        }

        const passHash = await hashPassword(password);
        const now = Date.now();
        const res = await env.DB.prepare(
          "INSERT INTO users (username, password_hash, role, is_active, created_at) VALUES (?, ?, 'ADMIN', 1, ?)"
        )
          .bind(username, passHash, now)
          .run();

        const uid = res.meta.last_row_id;
        const token = await signSessionToken(
          { uid, exp: now + 7 * 24 * 3600 * 1000 },
          env.SESSION_SECRET
        );
        return jsonRes(
          { ok: true, user: { id: uid, username, role: "ADMIN" } },
          200,
          { "Set-Cookie": makeSessionCookie(token, 7 * 24 * 3600) }
        );
      }

      if (method === "POST" && path === "/api/auth/login") {
        const body = await readJson(req);
        if (!body) return jsonRes({ ok: false, error: "Некорректный JSON." }, 400);
        const username = String(body.username || "").trim();
        const password = String(body.password || "");

        const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?")
          .bind(username)
          .first();
        if (!user || !(await verifyPassword(password, user.password_hash))) {
          return jsonRes({ ok: false, error: "Неверный логин или пароль." }, 401);
        }
        if (!user.is_active) {
          return jsonRes({ ok: false, error: "Учётная запись отключена." }, 403);
        }

        const token = await signSessionToken(
          { uid: user.id, exp: Date.now() + 7 * 24 * 3600 * 1000 },
          env.SESSION_SECRET
        );
        return jsonRes(
          { ok: true, user: { id: user.id, username: user.username, role: user.role } },
          200,
          { "Set-Cookie": makeSessionCookie(token, 7 * 24 * 3600) }
        );
      }

      if (method === "POST" && path === "/api/auth/register") {
        const body = await readJson(req);
        if (!body) return jsonRes({ ok: false, error: "Некорректный JSON." }, 400);
        const code = String(body.inviteCode || "").trim();
        const username = String(body.username || "").trim();
        const password = String(body.password || "");

        if (!code || username.length < 3 || password.length < 6) {
          return jsonRes(
            { ok: false, error: "Заполните инвайт-код, логин (от 3) и пароль (от 6)." },
            400
          );
        }

        const inv = await env.DB.prepare("SELECT * FROM invites WHERE code = ?")
          .bind(code)
          .first();
        if (!inv || inv.used_by != null) {
          return jsonRes(
            { ok: false, error: "Инвайт-код недействителен или уже использован." },
            403
          );
        }

        const exists = await env.DB.prepare("SELECT id FROM users WHERE username = ?")
          .bind(username)
          .first();
        if (exists) {
          return jsonRes({ ok: false, error: "Такой логин уже занят." }, 409);
        }

        const passHash = await hashPassword(password);
        const now = Date.now();
        const res = await env.DB.prepare(
          "INSERT INTO users (username, password_hash, role, is_active, created_at) VALUES (?, ?, ?, 1, ?)"
        )
          .bind(username, passHash, inv.role, now)
          .run();

        const uid = res.meta.last_row_id;
        await env.DB.prepare(
          "UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?"
        )
          .bind(uid, now, code)
          .run();

        const token = await signSessionToken(
          { uid, exp: now + 7 * 24 * 3600 * 1000 },
          env.SESSION_SECRET
        );
        return jsonRes(
          { ok: true, user: { id: uid, username, role: inv.role } },
          200,
          { "Set-Cookie": makeSessionCookie(token, 7 * 24 * 3600) }
        );
      }

      if (method === "POST" && path === "/api/auth/logout") {
        return jsonRes({ ok: true }, 200, {
          "Set-Cookie": makeSessionCookie("", 0)
        });
      }

      // --- EXTENSION API ---
      if (path.startsWith("/api/ext/")) {
        await expireTimedOutTickets(env.DB);

        if (method === "POST" && path === "/api/ext/start") {
          const body = await readJson(req);
          if (!body || !body.clientToken) {
            return jsonRes({ ok: false, error: "clientToken обязателен." }, 400);
          }
          const out = await handleExtStart(
            env.DB,
            String(body.clientToken),
            String(body.chatKey || "/app")
          );
          return jsonRes({ ok: true, ...out });
        }

        if (method === "POST" && path === "/api/ext/support") {
          const body = await readJson(req);
          if (!body || !body.clientToken || !body.text) {
            return jsonRes({ ok: false, error: "Некорректные данные." }, 400);
          }
          const ticket = await env.DB.prepare(
            `SELECT * FROM tickets
             WHERE client_token = ? AND chat_key = ? AND status IN ('ACTIVE', 'POOL')
             ORDER BY id DESC LIMIT 1`
          )
            .bind(String(body.clientToken), String(body.chatKey || "/app"))
            .first();
          if (!ticket) {
            return jsonRes({ ok: false, error: "Активный тикет не найден." }, 404);
          }
          const out = await handleExtSupportMessage(
            env.DB,
            ticket.id,
            String(body.text)
          );
          return jsonRes(out, out.ok ? 200 : 400);
        }

        if (method === "POST" && path === "/api/ext/stop") {
          const body = await readJson(req);
          if (!body || !body.clientToken) {
            return jsonRes({ ok: false, error: "clientToken обязателен." }, 400);
          }
          const ticket = await env.DB.prepare(
            `SELECT id FROM tickets
             WHERE client_token = ? AND chat_key = ? AND status != 'CLOSED'
             ORDER BY id DESC LIMIT 1`
          )
            .bind(String(body.clientToken), String(body.chatKey || "/app"))
            .first();
          if (!ticket) return jsonRes({ ok: false });
          const out = await handleExtStop(env.DB, ticket.id);
          return jsonRes(out);
        }

        if (method === "GET" && path === "/api/ext/poll") {
          const clientToken = url.searchParams.get("clientToken") || "";
          if (!clientToken) {
            return jsonRes({ ok: false, error: "clientToken обязателен." }, 400);
          }
          const { results: msgs } = await env.DB.prepare(
            `SELECT m.id, m.ticket_id, m.text, t.chat_key
             FROM messages m
             JOIN tickets t ON t.id = m.ticket_id
             WHERE t.client_token = ? AND m.sender = 'SUPPORT' AND m.delivered_to_ext = 0
             ORDER BY m.id ASC`
          )
            .bind(clientToken)
            .all();

          if (msgs && msgs.length > 0) {
            await env.DB.batch(
              msgs.map((m) =>
                env.DB.prepare("UPDATE messages SET delivered_to_ext = 1 WHERE id = ?").bind(
                  m.id
                )
              )
            );
          }
          return jsonRes({ ok: true, deliveries: msgs || [] });
        }
      }

      // --- PANEL API ---
      if (path.startsWith("/api/panel/")) {
        const user = await getAuthUser(req, env);
        if (!user) {
          return jsonRes({ ok: false, error: "Требуется авторизация." }, 401);
        }

        await expireTimedOutTickets(env.DB);

        if (method === "GET" && path === "/api/panel/state") {
          const ticketIdRaw = url.searchParams.get("ticketId");
          const ticketId = ticketIdRaw ? parseInt(ticketIdRaw, 10) : null;

          const { results: tickets } = await env.DB.prepare(
            "SELECT * FROM tickets ORDER BY id DESC LIMIT 200"
          ).all();

          let messages = [];
          let internalMessages = [];
          if (ticketId) {
            const msgRes = await env.DB.prepare(
              "SELECT * FROM messages WHERE ticket_id = ? AND sender != 'INTERNAL' ORDER BY id ASC"
            )
              .bind(ticketId)
              .all();
            messages = msgRes.results || [];

            const intRes = await env.DB.prepare(
              "SELECT * FROM messages WHERE ticket_id = ? AND sender = 'INTERNAL' ORDER BY id ASC"
            )
              .bind(ticketId)
              .all();
            internalMessages = intRes.results || [];
          }

          const surveyState = await buildSurveyState(env.DB, user.id);
          const timeoutMinutes =
            parseInt(await getSetting(env.DB, "timeout_minutes", "30"), 10) || 30;

          let users = [];
          let invites = [];
          if (user.role === "ADMIN") {
            const uRes = await env.DB.prepare(
              "SELECT id, username, role, is_active, created_at FROM users ORDER BY id ASC"
            ).all();
            users = uRes.results || [];

            const iRes = await env.DB.prepare(
              `SELECT i.*, u1.username AS created_by_name, u2.username AS used_by_name
               FROM invites i
               LEFT JOIN users u1 ON u1.id = i.created_by
               LEFT JOIN users u2 ON u2.id = i.used_by
               ORDER BY i.created_at DESC LIMIT 100`
            ).all();
            invites = iRes.results || [];
          }

          return jsonRes({
            ok: true,
            user,
            tickets: tickets || [],
            messages,
            internalMessages,
            surveyState,
            timeoutMinutes,
            users,
            invites
          });
        }

        const actMatch = path.match(/^\/api\/panel\/tickets\/(\d+)\/activate$/);
        if (method === "POST" && actMatch) {
          const tid = parseInt(actMatch[1], 10);
          const ticket = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?")
            .bind(tid)
            .first();
          if (!ticket) return jsonRes({ ok: false, error: "Тикет не найден." }, 404);
          if (ticket.status !== "PENDING") {
            return jsonRes({ ok: false, error: "Тикет уже активирован или закрыт." }, 400);
          }

          const now = Date.now();
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE tickets
               SET status = 'ACTIVE', can_reply = 0, waiting_since = NULL,
                   assigned_to = ?, assigned_username = ?, updated_at = ?
               WHERE id = ?`
            ).bind(user.id, user.username, now, tid),
            env.DB.prepare(
              `INSERT INTO messages (ticket_id, sender, author_user_id, author_name, text, delivered_to_ext, created_at)
               VALUES (?, 'SYSTEM', 'СИСТЕМА', ?, 1, ?)`
            ).bind(
              tid,
              `Тикет активирован оператором ${user.username}. Стартовая инструкция поставлена в очередь доставки Gemini.`,
              now
            ),
            env.DB.prepare(
              `INSERT INTO messages (ticket_id, sender, author_user_id, author_name, text, delivered_to_ext, created_at)
               VALUES (?, 'SUPPORT', ?, ?, ?, 0, ?)`
            ).bind(tid, user.id, user.username, STARTING_INSTRUCTION_MESSAGE, now)
          ]);
          return jsonRes({ ok: true });
        }

        const claimMatch = path.match(/^\/api\/panel\/tickets\/(\d+)\/claim$/);
        if (method === "POST" && claimMatch) {
          const tid = parseInt(claimMatch[1], 10);
          const ticket = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?")
            .bind(tid)
            .first();
          if (!ticket) return jsonRes({ ok: false, error: "Тикет не найден." }, 404);
          if (ticket.status === "CLOSED") {
            return jsonRes({ ok: false, error: "Тикет закрыт." }, 400);
          }

          const now = Date.now();
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE tickets SET assigned_to = ?, assigned_username = ?, updated_at = ? WHERE id = ?`
            ).bind(user.id, user.username, now, tid),
            env.DB.prepare(
              `INSERT INTO messages (ticket_id, sender, author_name, text, delivered_to_ext, created_at)
               VALUES (?, 'SYSTEM', 'СИСТЕМА', ?, 1, ?)`
            ).bind(tid, `Тикет закреплён за сотрудником ${user.username}.`, now)
          ]);
          return jsonRes({ ok: true });
        }

        const escMatch = path.match(/^\/api\/panel\/tickets\/(\d+)\/escalate$/);
        if (method === "POST" && escMatch) {
          const tid = parseInt(escMatch[1], 10);
          const body = await readJson(req);
          const reason = String((body && body.reason) || "").trim() || "Требуется мнение коллег";

          const ticket = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?")
            .bind(tid)
            .first();
          if (!ticket) return jsonRes({ ok: false, error: "Тикет не найден." }, 404);
          if (ticket.status !== "ACTIVE" && ticket.status !== "POOL") {
            return jsonRes({ ok: false, error: "В пул можно передать только активный тикет." }, 400);
          }

          const now = Date.now();
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE tickets SET status = 'POOL', pool_reason = ?, assigned_to = NULL, assigned_username = NULL, updated_at = ? WHERE id = ?`
            ).bind(reason, now, tid),
            env.DB.prepare(
              `INSERT INTO messages (ticket_id, sender, author_name, text, delivered_to_ext, created_at)
               VALUES (?, 'SYSTEM', 'СИСТЕМА', ?, 1, ?)`
            ).bind(
              tid,
              `${user.username} передал(а) тикет в ОБЩИЙ ПУЛ. Причина: ${reason}`,
              now
            )
          ]);
          return jsonRes({ ok: true });
        }

        const replyMatch = path.match(/^\/api\/panel\/tickets\/(\d+)\/reply$/);
        if (method === "POST" && replyMatch) {
          const tid = parseInt(replyMatch[1], 10);
          const body = await readJson(req);
          const cleanText = String((body && body.text) || "").trim();
          const isSurvey = !!(body && body.isSurveyQuestion);

          if (!cleanText) {
            return jsonRes({ ok: false, error: "Текст ответа не может быть пустым." }, 400);
          }
          if (isSurvey && user.role !== "ADMIN") {
            return jsonRes(
              { ok: false, error: "Отправлять сообщения с пометкой «Опрос» может только ADMIN." },
              403
            );
          }

          const ticket = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?")
            .bind(tid)
            .first();
          if (!ticket) return jsonRes({ ok: false, error: "Тикет не найден." }, 404);
          if (ticket.status !== "ACTIVE" && ticket.status !== "POOL") {
            return jsonRes({ ok: false, error: "Тикет не активен." }, 400);
          }
          if (!ticket.can_reply) {
            return jsonRes(
              { ok: false, error: "Ожидание нового обращения от Gemini в [[support]]." },
              400
            );
          }

          const safeBody = cleanText.replace(/\[\[\/supportresponse\]\]/gi, "[/supportresponse]");
          const payload = `[[supportresponse]]${safeBody}[[/supportresponse]]`;
          const now = Date.now();

          let surveyItemId = null;
          if (isSurvey) {
            const sRes = await env.DB.prepare(
              `INSERT INTO survey_items (ticket_id, question_text, asked_by_user_id, asked_by_name, created_at)
               VALUES (?, ?, ?, ?, ?)`
            )
              .bind(tid, safeBody, user.id, user.username, now)
              .run();
            surveyItemId = sRes.meta.last_row_id;
          }

          await env.DB.batch([
            env.DB.prepare(
              `UPDATE tickets
               SET can_reply = 0, waiting_since = NULL, assigned_to = ?, assigned_username = ?, updated_at = ?
               WHERE id = ?`
            ).bind(user.id, user.username, now, tid),
            env.DB.prepare(
              `INSERT INTO messages (ticket_id, sender, author_user_id, author_name, text, is_survey_question, survey_item_id, delivered_to_ext, created_at)
               VALUES (?, 'SUPPORT', ?, ?, ?, ?, ?, 0, ?)`
            ).bind(
              tid,
              user.id,
              user.username,
              payload,
              isSurvey ? 1 : 0,
              surveyItemId,
              now
            )
          ]);

          return jsonRes({ ok: true });
        }

        const intMatch = path.match(/^\/api\/panel\/tickets\/(\d+)\/internal$/);
        if (method === "POST" && intMatch) {
          const tid = parseInt(intMatch[1], 10);
          const body = await readJson(req);
          const text = String((body && body.text) || "").trim();
          if (!text) return jsonRes({ ok: false, error: "Пустое сообщение." }, 400);

          await env.DB.prepare(
            `INSERT INTO messages (ticket_id, sender, author_user_id, author_name, text, delivered_to_ext, created_at)
             VALUES (?, 'INTERNAL', ?, ?, ?, 1, ?)`
          )
            .bind(tid, user.id, user.username, text, Date.now())
            .run();

          return jsonRes({ ok: true });
        }

        const closeMatch = path.match(/^\/api\/panel\/tickets\/(\d+)\/close$/);
        if (method === "POST" && closeMatch) {
          const tid = parseInt(closeMatch[1], 10);
          const ticket = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?")
            .bind(tid)
            .first();
          if (!ticket) return jsonRes({ ok: false, error: "Тикет не найден." }, 404);
          if (ticket.status === "CLOSED") return jsonRes({ ok: true });

          const now = Date.now();
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE tickets
               SET status = 'CLOSED', close_reason = 'OPERATOR_CLOSE', can_reply = 0,
                   waiting_since = NULL, closed_at = ?, updated_at = ?
               WHERE id = ?`
            ).bind(now, now, tid),
            env.DB.prepare(
              `INSERT INTO messages (ticket_id, sender, author_name, text, delivered_to_ext, created_at)
               VALUES (?, 'SYSTEM', 'СИСТЕМА', ?, 1, ?)`
            ).bind(tid, `Тикет закрыт сотрудником ${user.username}.`, now),
            env.DB.prepare(
              `INSERT INTO messages (ticket_id, sender, author_user_id, author_name, text, delivered_to_ext, created_at)
               VALUES (?, 'SUPPORT', ?, ?, ?, 0, ?)`
            ).bind(tid, user.id, user.username, OPERATOR_CLOSED_NOTIFICATION, now)
          ]);
          return jsonRes({ ok: true });
        }

        const delMatch = path.match(/^\/api\/panel\/tickets\/(\d+)$/);
        if (method === "DELETE" && delMatch) {
          const tid = parseInt(delMatch[1], 10);
          const ticket = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?")
            .bind(tid)
            .first();
          if (!ticket) return jsonRes({ ok: false, error: "Тикет не найден." }, 404);
          if (ticket.status !== "CLOSED") {
            return jsonRes({ ok: false, error: "Удалять можно только закрытые тикеты." }, 400);
          }
          await env.DB.batch([
            env.DB.prepare("DELETE FROM messages WHERE ticket_id = ?").bind(tid),
            env.DB.prepare("DELETE FROM tickets WHERE id = ?").bind(tid)
          ]);
          return jsonRes({ ok: true });
        }

        if (method === "POST" && path === "/api/panel/tickets/delete-closed") {
          if (user.role !== "ADMIN") {
            return jsonRes({ ok: false, error: "Только для ADMIN." }, 403);
          }
          await env.DB.batch([
            env.DB.prepare(
              "DELETE FROM messages WHERE ticket_id IN (SELECT id FROM tickets WHERE status = 'CLOSED')"
            ),
            env.DB.prepare("DELETE FROM tickets WHERE status = 'CLOSED'")
          ]);
          return jsonRes({ ok: true });
        }

        if (method === "POST" && path === "/api/panel/db/clear-tickets") {
          if (user.role !== "ADMIN") {
            return jsonRes({ ok: false, error: "Только для ADMIN." }, 403);
          }
          await env.DB.batch([
            env.DB.prepare("DELETE FROM survey_votes"),
            env.DB.prepare("DELETE FROM survey_items"),
            env.DB.prepare("DELETE FROM messages"),
            env.DB.prepare("DELETE FROM tickets")
          ]);
          return jsonRes({ ok: true });
        }

        const voteMatch = path.match(/^\/api\/panel\/surveys\/(\d+)\/vote$/);
        if (method === "POST" && voteMatch) {
          const sid = parseInt(voteMatch[1], 10);
          const body = await readJson(req);
          const vote = body && body.vote === -1 ? -1 : 1;
          const now = Date.now();

          await env.DB.prepare(
            `INSERT INTO survey_votes (survey_item_id, user_id, vote, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(survey_item_id, user_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`
          )
            .bind(sid, user.id, vote, now)
            .run();

          const goodRow = await env.DB.prepare(
            "SELECT COUNT(*) AS c FROM survey_votes WHERE survey_item_id = ? AND vote = 1"
          )
            .bind(sid)
            .first();
          const badRow = await env.DB.prepare(
            "SELECT COUNT(*) AS c FROM survey_votes WHERE survey_item_id = ? AND vote = -1"
          )
            .bind(sid)
            .first();

          const good = goodRow ? goodRow.c : 0;
          const bad = badRow ? badRow.c : 0;
          const inStd = good > bad ? 1 : 0;

          await env.DB.prepare(
            "UPDATE survey_items SET good_votes = ?, bad_votes = ?, in_standard = ? WHERE id = ?"
          )
            .bind(good, bad, inStd, sid)
            .run();

          return jsonRes({ ok: true });
        }

        if (method === "POST" && path === "/api/panel/settings") {
          if (user.role !== "ADMIN") {
            return jsonRes({ ok: false, error: "Только для ADMIN." }, 403);
          }
          const body = await readJson(req);
          if (!body) return jsonRes({ ok: false, error: "Некорректный JSON." }, 400);

          if (body.timeoutMinutes != null) {
            const v = Math.max(1, Math.min(1440, parseInt(body.timeoutMinutes, 10) || 30));
            await setSetting(env.DB, "timeout_minutes", v);
          }
          if (body.surveyTriggerThreshold != null) {
            const v = Math.max(
              1,
              Math.min(500, parseInt(body.surveyTriggerThreshold, 10) || 3)
            );
            await setSetting(env.DB, "survey_trigger_threshold", v);
          }
          if (body.surveyManualOpen != null) {
            await setSetting(
              env.DB,
              "survey_manual_open",
              body.surveyManualOpen ? "1" : "0"
            );
          }
          return jsonRes({ ok: true });
        }

        if (method === "POST" && path === "/api/panel/admin/invites") {
          if (user.role !== "ADMIN") {
            return jsonRes({ ok: false, error: "Только для ADMIN." }, 403);
          }
          const body = await readJson(req);
          const role = body && body.role === "ADMIN" ? "ADMIN" : "OPERATOR";
          const rawBytes = crypto.getRandomValues(new Uint8Array(6));
          const code = "A2H-" + bufToHex(rawBytes).toUpperCase();
          await env.DB.prepare(
            "INSERT INTO invites (code, role, created_by, created_at) VALUES (?, ?, ?, ?)"
          )
            .bind(code, role, user.id, Date.now())
            .run();
          return jsonRes({ ok: true, code, role });
        }

        const invDelMatch = path.match(/^\/api\/panel\/admin\/invites\/([A-Za-z0-9-]+)$/);
        if (method === "DELETE" && invDelMatch) {
          if (user.role !== "ADMIN") {
            return jsonRes({ ok: false, error: "Только для ADMIN." }, 403);
          }
          await env.DB.prepare(
            "DELETE FROM invites WHERE code = ? AND used_by IS NULL"
          )
            .bind(invDelMatch[1])
            .run();
          return jsonRes({ ok: true });
        }

        const userToggleMatch = path.match(/^\/api\/panel\/admin\/users\/(\d+)\/toggle$/);
        if (method === "POST" && userToggleMatch) {
          if (user.role !== "ADMIN") {
            return jsonRes({ ok: false, error: "Только для ADMIN." }, 403);
          }
          const uid = parseInt(userToggleMatch[1], 10);
          if (uid === user.id) {
            return jsonRes({ ok: false, error: "Нельзя отключить самого себя." }, 400);
          }
          const target = await env.DB.prepare("SELECT is_active FROM users WHERE id = ?")
            .bind(uid)
            .first();
          if (!target) return jsonRes({ ok: false, error: "Пользователь не найден." }, 404);
          await env.DB.prepare("UPDATE users SET is_active = ? WHERE id = ?")
            .bind(target.is_active ? 0 : 1, uid)
            .run();
          return jsonRes({ ok: true });
        }

        if (method === "POST" && path === "/api/panel/sim") {
          if (user.role !== "ADMIN") {
            return jsonRes({ ok: false, error: "Только для ADMIN." }, 403);
          }
          const body = await readJson(req);
          if (!body) return jsonRes({ ok: false, error: "Некорректный JSON." }, 400);
          const action = body.action;

          if (action === "start") {
            const out = await handleExtStart(
              env.DB,
              String(body.clientToken || "sim-client"),
              String(body.chatKey || `/app/sim-${Math.floor(Date.now() / 1000)}`)
            );
            return jsonRes({ ok: true, ...out });
          }
          if (action === "support") {
            const out = await handleExtSupportMessage(
              env.DB,
              parseInt(body.ticketId, 10),
              String(body.text || "")
            );
            return jsonRes(out, out.ok ? 200 : 400);
          }
          if (action === "stop") {
            const out = await handleExtStop(env.DB, parseInt(body.ticketId, 10));
            return jsonRes(out);
          }
          return jsonRes({ ok: false, error: "Неизвестное действие симулятора." }, 400);
        }
      }

      return jsonRes({ ok: false, error: "API route not found" }, 404);
    } catch (err) {
      return jsonRes(
        {
          ok: false,
          error: "Внутренняя ошибка Worker: " + (err && err.message ? err.message : String(err))
        },
        500
      );
    }
  }
};
