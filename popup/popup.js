// Popup script for EMIAS Reschedule Assistant
document.addEventListener("DOMContentLoaded", async () => {
  // Tabs
  const tabButtons = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  // Elements
  const connStatus = document.getElementById("connection-status");
  const apptSelect = document.getElementById("appointment-select");
  const targetDtInput = document.getElementById("target-datetime");
  const timeWindowSelect = document.getElementById("time-window");
  const anyDoctorCb = document.getElementById("any-doctor");
  const findNowBtn = document.getElementById("find-now-btn");
  const toggleMonitorBtn = document.getElementById("toggle-monitor-btn");

  const monitorCard = document.getElementById("monitor-status-card");
  const monitorBadge = document.getElementById("monitor-badge");
  const monitorCounter = document.getElementById("monitor-counter");
  const monitorDetail = document.getElementById("monitor-detail");

  const quickSlotsContainer = document.getElementById("quick-slots-container");
  const slotsList = document.getElementById("slots-list");

  // Telegram Elements
  const tgTokenInput = document.getElementById("tg-token");
  const tgChatIdInput = document.getElementById("tg-chat-id");
  const saveTgBtn = document.getElementById("save-tg-btn");
  const testTgBtn = document.getElementById("test-tg-btn");
  const tgTestStatus = document.getElementById("tg-test-status");

  // Sniffer Elements
  const requestsCount = document.getElementById("requests-count");
  const requestsContainer = document.getElementById("requests-container");
  const copySummaryBtn = document.getElementById("copy-summary-btn");
  const clearRequestsBtn = document.getElementById("clear-requests-btn");
  const toast = document.getElementById("toast");

  function showToast(text, duration = 2200) {
    toast.textContent = text;
    toast.classList.remove("hidden");
    setTimeout(() => toast.classList.add("hidden"), duration);
  }

  // Tab switching
  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      tabButtons.forEach(b => b.classList.remove("active"));
      tabContents.forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-tab");
      document.getElementById(targetId).classList.add("active");
    });
  });

  // Get active EMIAS tab
  async function getActiveEmiaTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      if (tab && tab.url && tab.url.includes("emias.info")) {
        return tab;
      }
      // Fallback: look for any emias tab in window
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      return allTabs.find(t => t.url && t.url.includes("emias.info")) || null;
    } catch (e) {
      return null;
    }
  }

  // Update connection indicator
  async function updateConnection() {
    const tab = await getActiveEmiaTab();
    if (tab) {
      connStatus.className = "status-pill status-connected";
      connStatus.innerHTML = '<span class="dot"></span><span class="status-text">ЕМИАС подключен</span>';
    } else {
      connStatus.className = "status-pill status-disconnected";
      connStatus.innerHTML = '<span class="dot"></span><span class="status-text">Откройте emias.info</span>';
    }
    return tab;
  }

  // Load active appointments into select
  async function loadAppointments() {
    const store = await chrome.storage.local.get("appointments");
    const list = store.appointments || [];

    apptSelect.innerHTML = "";

    if (list.length === 0) {
      apptSelect.innerHTML = '<option value="">Нет сохраненных записей. Откройте ЕМИАС</option>';
      return;
    }

    list.forEach(a => {
      const opt = document.createElement("option");
      opt.value = a.id;
      const start = new Date(a.startTime);
      const dateStr = start.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
      const timeStr = start.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      const title = a.toBM ? a.toBM.name : (a.specialityName || "Приём врача");
      opt.textContent = `[${a.number || "Запись"}] ${title} — ${dateStr} в ${timeStr}`;
      apptSelect.appendChild(opt);
    });
  }

  // Populate default target datetime
  async function initTargetDateTime() {
    const store = await chrome.storage.local.get("monitoringConfig");
    if (store.monitoringConfig && store.monitoringConfig.targetDatetime) {
      targetDtInput.value = store.monitoringConfig.targetDatetime;
      if (store.monitoringConfig.timeWindow) timeWindowSelect.value = store.monitoringConfig.timeWindow;
      if (store.monitoringConfig.anyDoctor !== undefined) anyDoctorCb.checked = store.monitoringConfig.anyDoctor;
      if (store.monitoringConfig.appointmentId) apptSelect.value = store.monitoringConfig.appointmentId;
    } else {
      // Default: tomorrow at 10:00
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(10, 0, 0, 0);
      const localIso = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      targetDtInput.value = localIso;
    }
  }

  // Render Monitor Card
  async function updateMonitorCard() {
    const store = await chrome.storage.local.get(["monitoringActive", "monitoringConfig"]);
    const isActive = Boolean(store.monitoringActive);
    const config = store.monitoringConfig || {};

    if (isActive) {
      monitorCard.className = "monitor-card active";
      monitorBadge.innerHTML = "🟢 Автопоиск запущен";
      monitorBadge.style.color = "#15803d";
      monitorCounter.textContent = `Проверок: ${config.checkCount || 0}`;
      monitorDetail.textContent = `Отслеживание слотов для выбранной записи с интервалом 20-30с. При появлении слота будет выполнен мгновенный перенос.`;
      toggleMonitorBtn.textContent = "⏹️ Остановить поиск";
      toggleMonitorBtn.className = "btn btn-danger";
    } else {
      monitorCard.className = "monitor-card inactive";
      monitorBadge.innerHTML = "⚪ Мониторинг выключен";
      monitorBadge.style.color = "#475569";
      monitorCounter.textContent = "";
      monitorDetail.textContent = "Выберите запись, желаемое время и нажмите кнопку автопереноса.";
      toggleMonitorBtn.textContent = "🚀 Запустить автоперенос";
      toggleMonitorBtn.className = "btn btn-primary";
    }
  }

  // Find Now
  findNowBtn.addEventListener("click", async () => {
    const tab = await getActiveEmiaTab();
    if (!tab) {
      alert("Откройте вкладку https://emias.info/app/einfo/ в браузере!");
      return;
    }

    if (!targetDtInput.value) {
      alert("Укажите желаемую дату и время");
      return;
    }

    findNowBtn.disabled = true;
    findNowBtn.innerText = "🔍 Поиск слотов...";
    quickSlotsContainer.classList.remove("hidden");
    slotsList.innerHTML = `<div style="color:#64748b;text-align:center;padding:10px;">Запрос расписания...</div>`;

    try {
      const payload = {
        appointmentId: apptSelect.value,
        targetDatetime: targetDtInput.value,
        timeWindow: timeWindowSelect.value,
        anyDoctor: anyDoctorCb.checked
      };

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "POPUP_SEARCH_SLOTS",
        payload
      });

      if (!response || !response.success) {
        slotsList.innerHTML = `<div style="color:#dc2626;padding:8px;">${response ? response.error : "Нет ответа от страницы ЕМИАС. Обновите вкладку ЕМИАС."}</div>`;
        return;
      }

      const matched = response.matchedSlots || [];
      if (matched.length === 0) {
        slotsList.innerHTML = `<div style="color:#64748b;text-align:center;padding:10px;">На эту дату подходящих слотов не найдено (всего проверено: ${response.totalSlots}). Запустите автоперенос для ожидания отмен.</div>`;
      } else {
        slotsList.innerHTML = "";
        matched.slice(0, 6).forEach(slot => {
          const card = document.createElement("div");
          card.className = "slot-card";
          card.innerHTML = `
            <div>
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="slot-time">${slot.formattedTime}</span>
                <span class="slot-delta">Δ ${slot.absDiffMinutes} мин</span>
              </div>
              <div class="slot-meta">${slot.doctorName || slot.cabinet || ""} · ${slot.lpuName}</div>
            </div>
            <button class="slot-shift-btn">Перенести</button>
          `;

          const btn = card.querySelector(".slot-shift-btn");
          btn.addEventListener("click", async () => {
            if (confirm(`Подтвердите перенос записи на ${slot.formattedFull}?`)) {
              btn.disabled = true;
              btn.innerText = "...";
              const shiftRes = await chrome.tabs.sendMessage(tab.id, {
                type: "POPUP_EXECUTE_SHIFT",
                payload: {
                  appointmentId: apptSelect.value,
                  targetSlot: slot
                }
              });

              if (shiftRes && shiftRes.success) {
                showToast("✅ Запись успешно перенесена!");
                setTimeout(() => window.close(), 1200);
              } else {
                alert("Ошибка переноса: " + (shiftRes ? shiftRes.error : "Неизвестная ошибка"));
                btn.disabled = false;
                btn.innerText = "Перенести";
              }
            }
          });

          slotsList.appendChild(card);
        });
      }
    } catch (err) {
      slotsList.innerHTML = `<div style="color:#dc2626;padding:8px;">Ошибка связи: ${err.message}. Убедитесь, что вкладка ЕМИАС открыта.</div>`;
    } finally {
      findNowBtn.disabled = false;
      findNowBtn.innerText = "🔍 Найти слоты сейчас";
    }
  });

  // Toggle Monitor
  toggleMonitorBtn.addEventListener("click", async () => {
    const tab = await getActiveEmiaTab();
    if (!tab) {
      alert("Откройте вкладку https://emias.info/app/einfo/ в браузере!");
      return;
    }

    const store = await chrome.storage.local.get("monitoringActive");
    const isActive = Boolean(store.monitoringActive);

    if (isActive) {
      await chrome.tabs.sendMessage(tab.id, { type: "POPUP_STOP_MONITOR" });
      await updateMonitorCard();
      showToast("Мониторинг остановлен");
    } else {
      if (!targetDtInput.value) {
        alert("Укажите желаемое время");
        return;
      }

      const config = {
        appointmentId: apptSelect.value,
        targetDatetime: targetDtInput.value,
        timeWindow: timeWindowSelect.value,
        anyDoctor: anyDoctorCb.checked,
        checkCount: 0
      };

      await chrome.tabs.sendMessage(tab.id, {
        type: "POPUP_START_MONITOR",
        payload: config
      });

      await updateMonitorCard();
      showToast("🚀 Автоперенос запущен!");
    }
  });

  // Telegram Tab Settings
  async function loadTgSettings() {
    const store = await chrome.storage.local.get(["tgToken", "tgChatId"]);
    if (store.tgToken) tgTokenInput.value = store.tgToken;
    if (store.tgChatId) tgChatIdInput.value = store.tgChatId;
  }

  saveTgBtn.addEventListener("click", async () => {
    await chrome.storage.local.set({
      tgToken: tgTokenInput.value.trim(),
      tgChatId: tgChatIdInput.value.trim()
    });
    showToast("Настройки Telegram сохранены!");
  });

  testTgBtn.addEventListener("click", async () => {
    const botToken = tgTokenInput.value.trim();
    const chatId = tgChatIdInput.value.trim();

    if (!botToken || !chatId) {
      tgTestStatus.className = "status-msg error";
      tgTestStatus.textContent = "Заполните Bot Token и Chat ID";
      return;
    }

    tgTestStatus.className = "status-msg";
    tgTestStatus.textContent = "Отправка сообщения...";

    const res = await chrome.runtime.sendMessage({
      type: "SEND_TELEGRAM_TEST",
      payload: { botToken, chatId }
    });

    if (res && res.success) {
      tgTestStatus.className = "status-msg success";
      tgTestStatus.textContent = "✅ Сообщение успешно доставлено в Telegram!";
    } else {
      tgTestStatus.className = "status-msg error";
      tgTestStatus.textContent = `❌ Ошибка: ${res ? res.error : "Не удалось отправить"}`;
    }
  });

  // Sniffer Tab
  async function loadRequests() {
    const data = await chrome.storage.local.get("capturedRequests");
    const list = data.capturedRequests || [];
    requestsCount.textContent = list.length;

    if (list.length === 0) {
      requestsContainer.innerHTML = `
        <div class="empty-state">
          <span>Ожидание сетевой активности на emias.info...</span>
        </div>
      `;
      return;
    }

    requestsContainer.innerHTML = "";
    list.slice().reverse().forEach(req => {
      const item = document.createElement("div");
      item.className = "req-item";
      const methodClass = req.method === "GET" ? "req-get" : (req.method === "POST" ? "req-post" : "req-other");
      const shortUrl = req.url.length > 55 ? req.url.substring(0, 55) + "..." : req.url;
      item.innerHTML = `
        <div class="req-header">
          <span class="req-badge ${methodClass}">${req.method}</span>
          <span class="req-time">${req.timestamp} [${req.status}]</span>
        </div>
        <div class="req-url" title="${req.url}">${shortUrl}</div>
      `;
      requestsContainer.appendChild(item);
    });
  }

  copySummaryBtn.addEventListener("click", async () => {
    const data = await chrome.storage.local.get("capturedRequests");
    const list = data.capturedRequests || [];
    if (list.length === 0) {
      showToast("⚠️ Нет запросов для копирования");
      return;
    }
    const report = {
      total: list.length,
      endpoints: list.map(r => ({ method: r.method, url: r.url, status: r.status, request: r.requestBody, response: r.responseBody }))
    };
    await navigator.clipboard.writeText("```json\n" + JSON.stringify(report, null, 2) + "\n```");
    showToast("📋 Схема скопирована!");
  });

  clearRequestsBtn.addEventListener("click", async () => {
    await chrome.storage.local.set({ capturedRequests: [] });
    await loadRequests();
    showToast("Журнал очищен");
  });

  // Init
  await updateConnection();
  await loadAppointments();
  await initTargetDateTime();
  await updateMonitorCard();
  await loadTgSettings();
  await loadRequests();

  // Polling update for popup UI
  setInterval(async () => {
    await updateMonitorCard();
  }, 1500);
});
