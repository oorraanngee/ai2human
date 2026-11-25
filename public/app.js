(() => {
  const state = {
    user: null,
    tickets: [],
    messages: [],
    internalMessages: [],
    surveyState: null,
    timeoutMinutes: 30,
    users: [],
    invites: [],
    selectedTicketId: null,
    modalTicketId: null,
    chatTab: "external",
    activeView: "tickets"
  };

  const el = (id) => document.getElementById(id);

  function showBootError(msg) {
    const l = el("bootLoadingBanner");
    if (l) l.classList.add("hidden");
    const b = el("bootErrorBanner");
    b.textContent = msg;
    b.classList.remove("hidden");
  }

  async function api(url, method = "GET", body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    const txt = await r.text();
    try {
      return JSON.parse(txt);
    } catch {
      return { ok: false, error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
  }

  function fmtId(id) {
    return "#" + String(id).padStart(4, "0");
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleTimeString("ru-RU", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function fmtCountdown(waitingSince) {
    if (!waitingSince) return "—";
    const limitMs = state.timeoutMinutes * 60 * 1000;
    const left = waitingSince + limitMs - Date.now();
    if (left <= 0) return "00:00";
    const sec = Math.floor(left / 1000);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function statusLabel(t) {
    if (t.status === "PENDING") return "ОЖИДАЕТ";
    if (t.status === "ACTIVE") return "АКТИВЕН";
    if (t.status === "POOL") return "В ПУЛЕ";
    if (t.status === "CLOSED") return t.close_reason === "TIMEOUT" ? "ТАЙМАУТ" : "ЗАКРЫТ";
    return t.status;
  }

  function statusClass(s) {
    if (s === "PENDING") return "badge badge-pending";
    if (s === "ACTIVE") return "badge badge-active";
    if (s === "POOL") return "badge badge-pool";
    return "badge badge-closed";
  }

  async function boot() {
    el("bootErrorBanner").classList.add("hidden");
    try {
      const res = await api("/api/auth/me", "GET");
      const l = el("bootLoadingBanner");
      if (l) l.classList.add("hidden");

      if (!res || !res.ok) {
        showBootError((res && res.error) || "Не удалось подключиться к серверу.");
        return;
      }
      if (res.needsSetup) {
        el("authScreen").classList.remove("hidden");
        el("mainScreen").classList.add("hidden");
        el("setupFormBlock").classList.remove("hidden");
        el("loginTabsBlock").classList.add("hidden");
      } else if (!res.user) {
        el("authScreen").classList.remove("hidden");
        el("mainScreen").classList.add("hidden");
        el("setupFormBlock").classList.add("hidden");
        el("loginTabsBlock").classList.remove("hidden");
      } else {
        state.user = res.user;
        el("authScreen").classList.add("hidden");
        el("mainScreen").classList.remove("hidden");
        el("currentUserBadge").textContent = `${res.user.username} [${res.user.role}]`;
        if (res.user.role === "ADMIN") {
          el("navAdminBtn").classList.remove("hidden");
          el("isSurveyCheckbox").disabled = false;
        } else {
          el("navAdminBtn").classList.add("hidden");
          el("isSurveyCheckbox").disabled = true;
          el("isSurveyCheckbox").checked = false;
          el("surveyCheckLabel").title = "Отправлять опросы может только ADMIN";
        }
        refreshPanel();
      }
    } catch (err) {
      showBootError(`Ошибка запуска: ${err.message || err}`);
    }
  }

  async function refreshPanel() {
    if (!state.user) return;
    const q = state.selectedTicketId ? `?ticketId=${state.selectedTicketId}` : "";
    const res = await api("/api/panel/state" + q, "GET");
    if (!res || !res.ok) {
      if (res && res.error === "Требуется авторизация.") boot();
      return;
    }

    state.user = res.user;
    state.tickets = res.tickets || [];
    state.messages = res.messages || [];
    state.internalMessages = res.internalMessages || [];
    state.surveyState = res.surveyState;
    state.timeoutMinutes = res.timeoutMinutes || 30;
    state.users = res.users || [];
    state.invites = res.invites || [];

    if (state.selectedTicketId && !state.tickets.some((t) => t.id === state.selectedTicketId)) {
      state.selectedTicketId = null;
      state.messages = [];
      state.internalMessages = [];
    }

    renderTickets();
    renderSelectedTicket();
    renderSurveys();
    renderAdmin();
  }

  function renderTickets() {
    el("timeoutHintVal").textContent = String(state.timeoutMinutes);
    el("statusTicketsCount").textContent = `ТИКЕТОВ: ${state.tickets.length}`;

    const mode = el("ticketFilter").value;
    const list = state.tickets.filter((t) => {
      if (mode === "OPEN") return t.status === "PENDING" || t.status === "ACTIVE" || t.status === "POOL";
      if (mode === "POOL") return t.status === "POOL";
      if (mode === "CLOSED") return t.status === "CLOSED";
      return true;
    });

    const tbody = el("ticketListBody");
    tbody.innerHTML = "";
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-cell">Тикетов по фильтру нет.</td></tr>';
      return;
    }

    for (const t of list) {
      const tr = document.createElement("tr");
      if (t.id === state.selectedTicketId) tr.className = "selected-row";

      const td1 = document.createElement("td");
      td1.textContent = fmtId(t.id);

      const td2 = document.createElement("td");
      const sp = document.createElement("span");
      sp.className = statusClass(t.status);
      sp.textContent = statusLabel(t);
      td2.appendChild(sp);
      if ((t.status === "ACTIVE" || t.status === "POOL") && t.can_reply) {
        const wb = document.createElement("span");
        wb.className = "badge badge-wait";
        wb.textContent = "ОТВЕТ";
        td2.appendChild(wb);
      }

      const td3 = document.createElement("td");
      td3.textContent = t.assigned_username || "—";

      const td4 = document.createElement("td");
      td4.setAttribute("data-wait", t.waiting_since ? String(t.waiting_since) : "");
      td4.textContent = t.waiting_since ? fmtCountdown(t.waiting_since) : "—";

      tr.append(td1, td2, td3, td4);
      tr.addEventListener("click", () => openTicketModal(t.id));
      tbody.appendChild(tr);
    }
  }

  function renderMessageList(container, list) {
    container.innerHTML = "";
    if (!list || list.length === 0) {
      container.innerHTML = '<div class="chat-placeholder">Сообщений пока нет.</div>';
      return;
    }
    for (const m of list) {
      const box = document.createElement("div");
      let cls = "log-entry-system";
      if (m.sender === "GEMINI") cls = "log-entry-gemini";
      else if (m.sender === "SUPPORT") cls = "log-entry-support";
      else if (m.sender === "INTERNAL") cls = "log-entry-internal";
      box.className = `log-entry ${cls}`;

      const meta = document.createElement("div");
      meta.className = "log-meta";
      const who = m.author_name || m.sender;
      const tag = m.is_survey_question ? " [ОПРОС]" : "";
      meta.textContent = `[${fmtTime(m.created_at)}] [${m.sender}: ${who}]${tag}`;

      let displayText = m.text || "";
      if (m.sender === "SUPPORT") {
        displayText = displayText
          .replace(/^\s*\[\[supportresponse\]\]\s*/i, "")
          .replace(/\s*\[\[\/supportresponse\]\]\s*$/i, "");
      }

      const body = document.createElement("div");
      body.textContent = displayText;

      box.append(meta, body);
      container.appendChild(box);
    }
    container.scrollTop = container.scrollHeight;
  }

  function renderSelectedTicket() {
    const t = state.tickets.find((x) => x.id === state.selectedTicketId);
    if (!t) {
      el("chatPanelHeader").textContent = "ПРОТОКОЛ ВЗАИМОДЕЙСТВИЯ — ТИКЕТ НЕ ВЫБРАН";
      el("ticketStatusStrip").textContent = "Выберите тикет из реестра слева.";
      el("chatLog").innerHTML = '<div class="chat-placeholder">Нет выбранного тикета.</div>';
      el("internalLog").innerHTML = '<div class="chat-placeholder">Нет выбранного тикета.</div>';
      el("claimBtn").disabled = true;
      el("escalateBtn").disabled = true;
      el("closeTicketBtn").disabled = true;
      el("deleteTicketBtn").disabled = true;
      el("replyInput").disabled = true;
      el("sendReplyBtn").disabled = true;
      el("insertStandardBtn").disabled = true;
      el("internalInput").disabled = true;
      el("sendInternalBtn").disabled = true;
      el("composerLockReason").textContent = "ТИКЕТ НЕ ВЫБРАН";
      el("composerLockReason").className = "lock-reason";
      el("statusMainText").textContent = "ГОТОВ К РАБОТЕ";
      return;
    }

    el("chatPanelHeader").textContent = `ПРОТОКОЛ — ТИКЕТ ${fmtId(t.id)} (${t.chat_key})`;
    el("ticketStatusStrip").textContent =
      `СТАТУС: ${statusLabel(t)} | ОПЕРАТОР: ${t.assigned_username || "НЕТ"} | GEMINI: ${t.is_generating ? "ДУМАЕТ" : "ЖДЁТ"}` +
      (t.pool_reason ? ` | ПУЛ: ${t.pool_reason}` : "") +
      (t.waiting_since ? ` | ДО ТАЙМАУТА: ${fmtCountdown(t.waiting_since)}` : "");

    el("claimBtn").disabled = t.status === "CLOSED";
    el("escalateBtn").disabled = !(t.status === "ACTIVE" || t.status === "POOL");
    el("closeTicketBtn").disabled = t.status === "CLOSED";
    el("deleteTicketBtn").disabled = t.status !== "CLOSED";
    el("internalInput").disabled = t.status === "CLOSED";
    el("sendInternalBtn").disabled = t.status === "CLOSED";

    renderMessageList(el("chatLog"), state.messages);
    renderMessageList(el("internalLog"), state.internalMessages);

    const canOpenInput = (t.status === "ACTIVE" || t.status === "POOL") && t.can_reply === 1;
    const canSend = canOpenInput && !t.is_generating;
    el("replyInput").disabled = !canOpenInput;
    el("sendReplyBtn").disabled = !canSend;
    el("insertStandardBtn").disabled = !canOpenInput;

    if (t.status === "PENDING") {
      el("composerLockReason").textContent = "ТИКЕТ НЕ АКТИВИРОВАН";
      el("composerLockReason").className = "lock-reason";
    } else if (t.status === "CLOSED") {
      el("composerLockReason").textContent = "ТИКЕТ ЗАКРЫТ";
      el("composerLockReason").className = "lock-reason";
    } else if (!t.can_reply) {
      el("composerLockReason").textContent = "ОЖИДАНИЕ [[support]] ОТ GEMINI";
      el("composerLockReason").className = "lock-reason";
    } else if (t.is_generating) {
      el("composerLockReason").textContent = "БЛОКИРОВКА: GEMINI ФОРМИРУЕТ ОТВЕТ...";
      el("composerLockReason").className = "lock-reason";
    } else {
      el("composerLockReason").textContent = "РАЗРЕШЕНО ОТПРАВИТЬ 1 ОТВЕТ";
      el("composerLockReason").className = "lock-reason unlocked";
    }
    el("statusMainText").textContent = `ТИКЕТ ${fmtId(t.id)} — ${statusLabel(t)}`;
  }

  function buildStandardSurveyText(items) {
    if (!items || items.length === 0) {
      return "Стандартный опрос пока не сформирован. Отправьте вопросы с пометкой [Опрос] и проголосуйте за лучшие во внутреннем опросе.";
    }
    const lines = ["СТАНДАРТНЫЙ ОПРОС (АКТУАЛЬНАЯ ВЕРСИЯ):", ""];
    items.forEach((it, idx) => {
      lines.push(`${idx + 1}. ${it.question_text} [+${it.good_votes} / -${it.bad_votes}]`);
    });
    return lines.join("\n");
  }

  function renderSurveys() {
    const s = state.surveyState;
    if (!s) return;
    el("pollStatusBadge").textContent = s.pollActive
      ? "ОПРОС АКТИВЕН"
      : `НАКОПЛЕНИЕ (${s.answeredCount}/${s.threshold})`;
    el("pollStatusBadge").className = s.pollActive ? "badge badge-active" : "badge badge-pending";

    el("surveyTriggerInfo").textContent =
      `Отвеченных опросных вопросов: ${s.answeredCount} | Порог запуска: ${s.threshold} | Всего вопросов [Опрос]: ${s.totalCount}`;

    el("standardSurveyBox").textContent = buildStandardSurveyText(s.standardQuestions);

    const box = el("surveyItemsList");
    box.innerHTML = "";

    if (!s.pollActive) {
      box.innerHTML = `<div class="chat-placeholder">Внутренний опрос откроется автоматически, когда накопится отвеченных вопросов: ${s.threshold} (сейчас: ${s.answeredCount}).</div>`;
      return;
    }

    if (!s.items || s.items.length === 0) {
      box.innerHTML = '<div class="chat-placeholder">Вопросов с пометкой [Опрос] ещё не отправлялось.</div>';
      return;
    }

    for (const it of s.items) {
      const card = document.createElement("div");
      card.className = "survey-card";

      const head = document.createElement("div");
      head.className = "survey-card-head";
      head.textContent = `Вопрос #${it.id} | Тикет ${fmtId(it.ticket_id)} | Автор: ${it.asked_by_name || "ADMIN"}`;

      const q = document.createElement("div");
      q.className = "survey-q";
      q.textContent = it.question_text;

      const a = document.createElement("div");
      a.className = "survey-a";
      a.textContent = it.ai_answer_text ? `Ответ ИИ: ${it.ai_answer_text}` : "Ожидается ответ ИИ...";

      const votes = document.createElement("div");
      votes.className = "survey-votes";

      const btnGood = document.createElement("button");
      btnGood.className = "btn btn-small" + (it.my_vote === 1 ? " btn-primary" : "");
      btnGood.textContent = `Хороший вопрос (${it.good_votes})`;
      btnGood.addEventListener("click", () => voteSurvey(it.id, 1));

      const btnBad = document.createElement("button");
      btnBad.className = "btn btn-small" + (it.my_vote === -1 ? " btn-danger" : "");
      btnBad.textContent = `Слабый (${it.bad_votes})`;
      btnBad.addEventListener("click", () => voteSurvey(it.id, -1));

      const stdMark = document.createElement("span");
      stdMark.className = it.in_standard ? "badge badge-active" : "badge badge-closed";
      stdMark.textContent = it.in_standard ? "В СТАНДАРТНОМ ОПРОСЕ" : "НЕ В СТАНДАРТЕ";

      votes.append(btnGood, btnBad, stdMark);
      card.append(head, q, a, votes);
      box.appendChild(card);
    }
  }

  async function voteSurvey(id, vote) {
    await api(`/api/panel/surveys/${id}/vote`, "POST", { vote });
    refreshPanel();
  }

  function renderAdmin() {
    if (!state.user || state.user.role !== "ADMIN") return;

    el("settingTimeoutInput").value = String(state.timeoutMinutes);
    if (state.surveyState) {
      el("settingThresholdInput").value = String(state.surveyState.threshold);
      el("settingManualPollCheck").checked = !!state.surveyState.manualOpen;
    }

    const invBox = el("invitesList");
    invBox.innerHTML = "";
    for (const inv of state.invites) {
      const row = document.createElement("div");
      row.className = "mini-row";
      const txt = document.createElement("span");
      txt.textContent = `${inv.code} [${inv.role}] ${inv.used_by_name ? "-> исп.: " + inv.used_by_name : "(свободен)"}`;
      row.appendChild(txt);
      if (!inv.used_by) {
        const del = document.createElement("button");
        del.className = "btn btn-small btn-danger";
        del.textContent = "X";
        del.addEventListener("click", async () => {
          await api(`/api/panel/admin/invites/${inv.code}`, "DELETE");
          refreshPanel();
        });
        row.appendChild(del);
      }
      invBox.appendChild(row);
    }

    const uBox = el("usersList");
    uBox.innerHTML = "";
    for (const u of state.users) {
      const row = document.createElement("div");
      row.className = "mini-row";
      const txt = document.createElement("span");
      txt.textContent = `${u.username} [${u.role}] ${u.is_active ? "АКТИВЕН" : "ОТКЛЮЧЁН"}`;
      row.appendChild(txt);
      if (u.id !== state.user.id) {
        const tog = document.createElement("button");
        tog.className = "btn btn-small";
        tog.textContent = u.is_active ? "Откл." : "Вкл.";
        tog.addEventListener("click", async () => {
          await api(`/api/panel/admin/users/${u.id}/toggle`, "POST");
          refreshPanel();
        });
        row.appendChild(tog);
      }
      uBox.appendChild(row);
    }
  }

  function openTicketModal(tid) {
    const t = state.tickets.find((x) => x.id === tid);
    if (!t) return;
    state.modalTicketId = tid;
    el("mError").textContent = "";
    el("modalTitle").textContent = `КАРТОЧКА ТИКЕТА ${fmtId(t.id)}`;
    el("mTicketId").textContent = fmtId(t.id);
    el("mTicketStatus").textContent = statusLabel(t);
    el("mTicketChat").textContent = t.chat_key;
    el("mTicketTime").textContent = new Date(t.created_at).toLocaleString("ru-RU");

    if (t.status === "PENDING") {
      el("mNotice").textContent =
        "Нажмите «Активировать тикет», чтобы войти в чат и поставить стартовую инструкцию в очередь отправки Gemini.";
      el("mActivateBtn").style.display = "inline-block";
      el("mOpenBtn").style.display = "none";
    } else {
      el("mNotice").textContent =
        "Нажмите «Открыть журнал», чтобы перейти к переписке и консилиуму по тикету.";
      el("mActivateBtn").style.display = "none";
      el("mOpenBtn").style.display = "inline-block";
    }
    el("ticketModal").classList.remove("hidden");
  }

  function closeModal() {
    state.modalTicketId = null;
    el("ticketModal").classList.add("hidden");
  }

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.getAttribute("data-view");
      state.activeView = v;
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("nav-active"));
      btn.classList.add("nav-active");
      el("viewTickets").classList.toggle("hidden", v !== "tickets");
      el("viewSurveys").classList.toggle("hidden", v !== "surveys");
      el("viewAdmin").classList.toggle("hidden", v !== "admin");
    });
  });

  el("tabBtnLogin").addEventListener("click", () => {
    el("tabBtnLogin").classList.add("subtab-active");
    el("tabBtnReg").classList.remove("subtab-active");
    el("loginForm").classList.remove("hidden");
    el("regForm").classList.add("hidden");
  });
  el("tabBtnReg").addEventListener("click", () => {
    el("tabBtnReg").classList.add("subtab-active");
    el("tabBtnLogin").classList.remove("subtab-active");
    el("regForm").classList.remove("hidden");
    el("loginForm").classList.add("hidden");
  });

  el("setupSubmitBtn").addEventListener("click", async () => {
    el("setupErr").textContent = "";
    const res = await api("/api/auth/setup", "POST", {
      setupKey: el("setupKeyInput").value,
      username: el("setupUserInput").value,
      password: el("setupPassInput").value
    });
    if (!res || !res.ok) {
      el("setupErr").textContent = (res && res.error) || "Ошибка.";
      return;
    }
    boot();
  });

  el("loginSubmitBtn").addEventListener("click", async () => {
    el("loginErr").textContent = "";
    const res = await api("/api/auth/login", "POST", {
      username: el("loginUserInput").value,
      password: el("loginPassInput").value
    });
    if (!res || !res.ok) {
      el("loginErr").textContent = (res && res.error) || "Ошибка входа.";
      return;
    }
    boot();
  });

  el("regSubmitBtn").addEventListener("click", async () => {
    el("regErr").textContent = "";
    const res = await api("/api/auth/register", "POST", {
      inviteCode: el("regInviteInput").value,
      username: el("regUserInput").value,
      password: el("regPassInput").value
    });
    if (!res || !res.ok) {
      el("regErr").textContent = (res && res.error) || "Ошибка регистрации.";
      return;
    }
    boot();
  });

  el("logoutBtn").addEventListener("click", async () => {
    await api("/api/auth/logout", "POST");
    state.user = null;
    boot();
  });

  el("chatTabExternal").addEventListener("click", () => {
    state.chatTab = "external";
    el("chatTabExternal").classList.add("subtab-active");
    el("chatTabInternal").classList.remove("subtab-active");
    el("chatLog").classList.remove("hidden");
    el("composerExternal").classList.remove("hidden");
    el("internalLog").classList.add("hidden");
    el("composerInternal").classList.add("hidden");
  });

  el("chatTabInternal").addEventListener("click", () => {
    state.chatTab = "internal";
    el("chatTabInternal").classList.add("subtab-active");
    el("chatTabExternal").classList.remove("subtab-active");
    el("internalLog").classList.remove("hidden");
    el("composerInternal").classList.remove("hidden");
    el("chatLog").classList.add("hidden");
    el("composerExternal").classList.add("hidden");
  });

  el("mActivateBtn").addEventListener("click", async () => {
    if (!state.modalTicketId) return;
    const res = await api(`/api/panel/tickets/${state.modalTicketId}/activate`, "POST");
    if (!res || !res.ok) {
      el("mError").textContent = (res && res.error) || "Ошибка.";
      return;
    }
    state.selectedTicketId = state.modalTicketId;
    closeModal();
    refreshPanel();
  });

  el("mOpenBtn").addEventListener("click", () => {
    state.selectedTicketId = state.modalTicketId;
    closeModal();
    refreshPanel();
  });

  el("mCancelBtn").addEventListener("click", closeModal);
  el("modalCloseX").addEventListener("click", closeModal);

  el("claimBtn").addEventListener("click", async () => {
    if (!state.selectedTicketId) return;
    await api(`/api/panel/tickets/${state.selectedTicketId}/claim`, "POST");
    refreshPanel();
  });

  el("escalateBtn").addEventListener("click", async () => {
    if (!state.selectedTicketId) return;
    const reason = prompt("Укажите причину передачи тикета в общий пул:", "Спорный вопрос, нужно мнение коллег");
    if (reason === null) return;
    await api(`/api/panel/tickets/${state.selectedTicketId}/escalate`, "POST", { reason });
    refreshPanel();
  });

  el("closeTicketBtn").addEventListener("click", async () => {
    if (!state.selectedTicketId) return;
    await api(`/api/panel/tickets/${state.selectedTicketId}/close`, "POST");
    refreshPanel();
  });

  el("deleteTicketBtn").addEventListener("click", async () => {
    if (!state.selectedTicketId) return;
    if (!confirm("Удалить закрытый тикет и его историю?")) return;
    await api(`/api/panel/tickets/${state.selectedTicketId}`, "DELETE");
    state.selectedTicketId = null;
    refreshPanel();
  });

  async function sendExternalReply() {
    if (!state.selectedTicketId) return;
    const text = el("replyInput").value.trim();
    if (!text) {
      el("actionFeedback").textContent = "Введите текст ответа.";
      return;
    }
    el("actionFeedback").textContent = "";
    const res = await api(`/api/panel/tickets/${state.selectedTicketId}/reply`, "POST", {
      text,
      isSurveyQuestion: el("isSurveyCheckbox").checked
    });
    if (!res || !res.ok) {
      el("actionFeedback").textContent = (res && res.error) || "Ошибка.";
      return;
    }
    el("replyInput").value = "";
    el("isSurveyCheckbox").checked = false;
    refreshPanel();
  }

  el("sendReplyBtn").addEventListener("click", sendExternalReply);
  el("replyInput").addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter" && !el("sendReplyBtn").disabled) {
      e.preventDefault();
      sendExternalReply();
    }
  });

  el("sendInternalBtn").addEventListener("click", async () => {
    if (!state.selectedTicketId) return;
    const text = el("internalInput").value.trim();
    if (!text) return;
    const res = await api(`/api/panel/tickets/${state.selectedTicketId}/internal`, "POST", { text });
    if (res && res.ok) {
      el("internalInput").value = "";
      refreshPanel();
    }
  });

  el("insertStandardBtn").addEventListener("click", () => {
    if (!state.surveyState) return;
    const items = state.surveyState.standardQuestions || [];
    if (items.length === 0) {
      el("actionFeedback").textContent = "Стандартный опрос пока пуст.";
      return;
    }
    const txt = items.map((it, idx) => `${idx + 1}) ${it.question_text}`).join("\n");
    el("replyInput").value = (el("replyInput").value ? el("replyInput").value + "\n\n" : "") + txt;
    if (state.user && state.user.role === "ADMIN") el("isSurveyCheckbox").checked = true;
  });

  el("openStandardModalBtn").addEventListener("click", () => {
    const items = state.surveyState ? state.surveyState.standardQuestions : [];
    el("stdModalText").value = buildStandardSurveyText(items);
    el("standardModal").classList.remove("hidden");
  });
  el("stdCloseBtn").addEventListener("click", () => el("standardModal").classList.add("hidden"));
  el("stdCloseX").addEventListener("click", () => el("standardModal").classList.add("hidden"));
  el("stdCopyBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(el("stdModalText").value).catch(() => {});
  });
  el("copyStandardBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(el("standardSurveyBox").textContent).catch(() => {});
  });

  el("createInviteBtn").addEventListener("click", async () => {
    const res = await api("/api/panel/admin/invites", "POST", { role: el("newInviteRole").value });
    if (res && res.ok) {
      el("newInviteResult").textContent = `Создан код (${res.role}): ${res.code}`;
      refreshPanel();
    }
  });

  el("saveSettingsBtn").addEventListener("click", async () => {
    const res = await api("/api/panel/settings", "POST", {
      timeoutMinutes: parseInt(el("settingTimeoutInput").value, 10) || 30,
      surveyTriggerThreshold: parseInt(el("settingThresholdInput").value, 10) || 3,
      surveyManualOpen: el("settingManualPollCheck").checked
    });
    el("settingsFeedback").textContent = res && res.ok ? "Настройки сохранены." : "Ошибка сохранения.";
    refreshPanel();
  });

  el("adminDeleteClosedBtn").addEventListener("click", async () => {
    if (!confirm("Удалить все закрытые тикеты?")) return;
    await api("/api/panel/tickets/delete-closed", "POST");
    refreshPanel();
  });

  el("adminClearDbBtn").addEventListener("click", async () => {
    if (!confirm("Удалить ВСЕ тикеты, сообщения и опросы из базы D1?")) return;
    await api("/api/panel/db/clear-tickets", "POST");
    state.selectedTicketId = null;
    refreshPanel();
  });

  el("simStartBtn").addEventListener("click", async () => {
    const res = await api("/api/panel/sim", "POST", {
      action: "start",
      chatKey: el("simChatKeyInput").value.trim() || "/app/test"
    });
    if (res && res.ok && res.ticket) {
      el("simTicketIdInput").value = String(res.ticket.id);
      el("simFeedback").textContent = `Создан тикет ${fmtId(res.ticket.id)} (ОЖИДАЕТ активации).`;
      refreshPanel();
    }
  });

  el("simSupportBtn").addEventListener("click", async () => {
    const res = await api("/api/panel/sim", "POST", {
      action: "support",
      ticketId: parseInt(el("simTicketIdInput").value, 10),
      text: el("simSupportText").value
    });
    el("simFeedback").textContent = res && res.ok ? "Обращение [[support]] отправлено." : ((res && res.error) || "Ошибка.");
    if (res && res.ok) el("simSupportText").value = "";
    refreshPanel();
  });

  el("simStopBtn").addEventListener("click", async () => {
    const res = await api("/api/panel/sim", "POST", {
      action: "stop",
      ticketId: parseInt(el("simTicketIdInput").value, 10)
    });
    el("simFeedback").textContent = res && res.ok ? "Тикет закрыт через stop(support)." : "Не удалось закрыть.";
    refreshPanel();
  });

  el("ticketFilter").addEventListener("change", renderTickets);
  el("refreshAllBtn").addEventListener("click", refreshPanel);

  setInterval(() => {
    document.querySelectorAll("[data-wait]").forEach((c) => {
      const ws = c.getAttribute("data-wait");
      if (ws) c.textContent = fmtCountdown(parseInt(ws, 10));
    });
  }, 1000);

  setInterval(() => {
    if (state.user) refreshPanel();
  }, 4000);

  boot();
})();
