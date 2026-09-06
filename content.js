// Content Script (Isolated World) with Semi-Auto Telegram Support
(() => {
  let capturedCount = 0;
  let monitoringTimer = null;
  let countdownTimer = null;
  let nextCheckTimestamp = 0;
  let isTgPollingActive = false;
  let lastTgUpdateId = 0;
  let pendingSlotToShift = null;

  // Sound chime synthesizer (Web Audio API)
  function playSuccessChime() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [523.25, 659.25, 783.99, 1046.50];
      notes.forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime + idx * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + idx * 0.12 + 0.35);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + idx * 0.12);
        osc.stop(audioCtx.currentTime + idx * 0.12 + 0.35);
      });
    } catch (e) {
      console.warn("AudioContext chime not available:", e);
    }
  }

  // Mini-log recording
  async function addLog(text, type = "info") {
    const time = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const store = await chrome.storage.local.get("monitoringLogs");
    const logs = store.monitoringLogs || [];
    logs.push({ time, text, type });
    if (logs.length > 20) logs.shift();
    await chrome.storage.local.set({ monitoringLogs: logs });
    renderMiniLogUi(logs);
  }

  // Prevent accidental tab closure while monitoring is active
  function beforeUnloadHandler(e) {
    e.preventDefault();
    e.returnValue = "Мониторинг ЕМИАС активен. Если закрыть вкладку, поиск остановится!";
    return e.returnValue;
  }

  function setUnloadProtection(enable) {
    if (enable) {
      window.addEventListener("beforeunload", beforeUnloadHandler);
    } else {
      window.removeEventListener("beforeunload", beforeUnloadHandler);
    }
  }

  // -------------------------------------------------------------
  // Bridge to MAIN world interceptor
  // -------------------------------------------------------------
  const pendingRequests = new Map();

  function executeBridgeCmd(action, payload, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const reqId = "cmd_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);

      const timer = setTimeout(() => {
        pendingRequests.delete(reqId);
        reject(new Error("Timeout waiting for bridge response: " + action));
      }, timeoutMs);

      pendingRequests.set(reqId, { resolve, reject, timer });

      window.postMessage({
        source: "EMIAS_EXTENSION_CONTENT",
        action,
        reqId,
        payload
      }, "*");
    });
  }

  // Listen for bridge responses & events from MAIN world
  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== "EMIAS_INTERCEPTOR") {
      return;
    }

    const { action, type, reqId, payload, data, error } = event.data;

    if (reqId && pendingRequests.has(reqId)) {
      const req = pendingRequests.get(reqId);
      clearTimeout(req.timer);
      pendingRequests.delete(reqId);

      if (error) req.reject(new Error(error));
      else req.resolve(data);
      return;
    }

    // Patient Context Sync
    if (type === "PATIENT_CONTEXT_SYNC" && payload) {
      const store = await chrome.storage.local.get("patientContext");
      const merged = { ...(store.patientContext || {}), ...payload };
      await chrome.storage.local.set({ patientContext: merged });
    }

    // EI-Token Sync
    if (type === "EI_TOKEN_SYNC" && payload && payload.eiToken) {
      await chrome.storage.local.set({ eiToken: payload.eiToken });
    }

    // Appointments Sync
    if (type === "APPOINTMENTS_SYNC" && payload) {
      await chrome.storage.local.set({
        appointments: payload.appointments,
        lastAppointmentsSync: Date.now()
      });
      renderFloatingUi();
    }

    // Doctors Info Sync
    if (type === "DOCTORS_INFO_SYNC" && payload) {
      const { appointmentId, doctorsInfo } = payload;
      const stored = await chrome.storage.local.get("doctorsInfoMap");
      const map = stored.doctorsInfoMap || {};
      map[appointmentId] = doctorsInfo;
      await chrome.storage.local.set({ doctorsInfoMap: map });
    }

    // Sniffer log
    if (type === "API_CAPTURED" && payload) {
      const store = await chrome.storage.local.get("capturedRequests");
      const list = store.capturedRequests || [];
      list.push(payload);
      if (list.length > 60) list.shift();
      await chrome.storage.local.set({ capturedRequests: list });
      capturedCount = list.length;
      updateFloatingCounter(capturedCount);
    }
  });

  // -------------------------------------------------------------
  // Schedule & Shift API
  // -------------------------------------------------------------
  async function fetchAvailableSchedule(appointment, targetDateStr) {
    const store = await chrome.storage.local.get(["patientContext", "doctorsInfoMap", "monitoringConfig", "eiToken"]);
    const patientContext = store.patientContext;
    if (!patientContext || !patientContext.omsNumber || !patientContext.birthDate) {
      throw new Error("Сессия не синхронизирована. Обновите страницу ЕМИАС (F5)");
    }

    const doctorsMap = store.doctorsInfoMap || {};
    const doctorsInfoList = doctorsMap[appointment.id] || [];

    // Calculate dates safely
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const cleanTargetDate = targetDateStr ? targetDateStr.split("T")[0] : todayStr;
    const dateFrom = cleanTargetDate < todayStr ? todayStr : cleanTargetDate;

    // Period: 7 days window starting from dateFrom
    const fromObj = new Date(dateFrom + "T00:00:00");
    const toObj = new Date(fromObj);
    toObj.setDate(toObj.getDate() + 7);
    const dateTo = `${toObj.getFullYear()}-${String(toObj.getMonth() + 1).padStart(2, '0')}-${String(toObj.getDate()).padStart(2, '0')}`;

    const resourcesToQuery = [];

    // 1. Current appointment's resource
    resourcesToQuery.push({
      availableResourceId: Number(appointment.availableResourceId),
      complexResourceId: Number(appointment.complexResourceId),
      lpuId: Number(appointment.lpuId),
      lpuName: appointment.nameLpu || "",
      name: appointment.roomNumber || ""
    });

    // 2. Other resources ONLY if complexResourceId is known
    const config = store.monitoringConfig || {};
    if (config.anyDoctor && Array.isArray(doctorsInfoList) && doctorsInfoList.length > 0) {
      for (const doc of doctorsInfoList) {
        if (Array.isArray(doc.availableResources)) {
          for (const res of doc.availableResources) {
            const resId = Number(res.id);
            if (resId !== Number(appointment.availableResourceId)) {
              const crList = res.complexResource;
              const compId = (Array.isArray(crList) && crList[0] && crList[0].id) ? Number(crList[0].id) : null;
              if (compId) {
                resourcesToQuery.push({
                  availableResourceId: resId,
                  complexResourceId: compId,
                  lpuId: Number(doc.lpuId || res.lpuId),
                  lpuName: doc.lpuShortName || doc.defaultAddress || "",
                  name: res.name || ""
                });
              }
            }
          }
        }
      }
    }

    let allSlots = [];

    for (const resInfo of resourcesToQuery) {
      try {
        const payload = {
          appointmentId: Number(appointment.id),
          availableResourceId: Number(resInfo.availableResourceId),
          complexResourceId: Number(resInfo.complexResourceId),
          omsNumber: String(patientContext.omsNumber),
          birthDate: String(patientContext.birthDate),
          eiToken: store.eiToken || null,
          period: {
            dateFrom: dateFrom,
            dateTo: dateTo
          }
        };

        const res = await executeBridgeCmd("CMD_GET_SCHEDULE", payload);
        if (res && res.payload && res.payload.scheduleOfDay) {
          const slots = extractSlotsFromSchedule(res.payload.scheduleOfDay, resInfo);
          allSlots = allSlots.concat(slots);
        }
      } catch (err) {
        console.warn("[EMIAS] Ошибка получения расписания ресурса:", resInfo.availableResourceId, err.message);
      }
    }

    return allSlots;
  }

  async function performShift(appointment, targetSlot) {
    const store = await chrome.storage.local.get(["patientContext", "eiToken"]);
    const patientContext = store.patientContext;
    if (!patientContext || !patientContext.omsNumber || !patientContext.birthDate) {
      throw new Error("Нет данных сессии пациента");
    }

    const payload = {
      appointmentId: Number(appointment.id),
      availableResourceId: Number(targetSlot.availableResourceId || appointment.availableResourceId),
      complexResourceId: Number(targetSlot.complexResourceId || appointment.complexResourceId),
      startTime: targetSlot.startTime,
      endTime: targetSlot.endTime,
      omsNumber: String(patientContext.omsNumber),
      birthDate: String(patientContext.birthDate),
      eiToken: store.eiToken || null
    };

    console.log("[EMIAS Assistant] Отправка запроса на сдвиг записи:", payload);
    const result = await executeBridgeCmd("CMD_SHIFT_APPOINTMENT", payload);

    if (result && result.payload && result.payload.appointmentId) {
      return result.payload;
    } else {
      const errMsg = (result && result.message) || (result && result.error && result.error.message) || "Ошибка переноса записи";
      throw new Error(errMsg);
    }
  }

  // -------------------------------------------------------------
  // Telegram 2-Way Bot Polling (/stop, /status, inline confirm)
  // -------------------------------------------------------------
  async function startTelegramPoller() {
    if (isTgPollingActive) return;
    isTgPollingActive = true;

    while (isTgPollingActive) {
      try {
        const store = await chrome.storage.local.get(["monitoringActive", "tgToken", "tgChatId", "monitoringConfig", "appointments"]);
        if (!store.monitoringActive || !store.tgToken) {
          isTgPollingActive = false;
          break;
        }

        const updates = await TelegramBot.getUpdates(store.tgToken, lastTgUpdateId + 1, 10);
        if (Array.isArray(updates) && updates.length > 0) {
          for (const u of updates) {
            lastTgUpdateId = Math.max(lastTgUpdateId, u.update_id);

            // Handle callback_query (inline buttons)
            if (u.callback_query) {
              const cb = u.callback_query;
              const fromId = String(cb.from?.id || "");
              const targetChatId = String(store.tgChatId || "");

              if (fromId === targetChatId || targetChatId.includes(fromId)) {
                await handleTelegramCallback(cb, store);
              }
            }

            // Handle text commands (/stop, /status)
            if (u.message && u.message.text) {
              const text = u.message.text.trim();
              const fromId = String(u.message.from?.id || "");
              const targetChatId = String(store.tgChatId || "");

              if (fromId === targetChatId || targetChatId.includes(fromId)) {
                await handleTelegramCommand(text, store);
              }
            }
          }
        }
      } catch (err) {
        console.warn("[TG Poller Error]", err);
        await new Promise(r => setTimeout(r, 4000));
      }

      await new Promise(r => setTimeout(r, 1500));
    }
  }

  async function handleTelegramCommand(cmdText, store) {
    const { tgToken, tgChatId, monitoringConfig, appointments } = store;

    if (cmdText === "/stop" || cmdText.includes("Прекратить") || cmdText.includes("Остановить")) {
      await stopMonitoring();
      await addLog("⏹️ Мониторинг остановлен по команде из Telegram", "stop");
      await TelegramBot.sendMessage(tgToken, tgChatId, "⏹️ *Мониторинг ЕМИАС остановлен.*\nЗапросы к порталу прекращены по вашей команде.", {
        replyMarkup: { remove_keyboard: true }
      });
    } else if (cmdText === "/status" || cmdText.includes("Статус") || cmdText.includes("статус")) {
      const appt = appointments?.find(a => String(a.id) === String(monitoringConfig?.appointmentId)) || appointments?.[0];
      const apptName = appt?.toBM ? appt.toBM.name : (appt?.specialityName || "Приём");
      const target = monitoringConfig?.targetDatetime ? new Date(monitoringConfig.targetDatetime).toLocaleString("ru-RU") : "не указана";

      const statusMsg = `📊 *Текущий статус мониторинга:*\n\n` +
        `🟢 *Состояние:* Активен\n` +
        `📋 *Запись:* ${apptName} (${appt?.number || ""})\n` +
        `🎯 *Целевое время:* ${target}\n` +
        `🔄 *Проверок выполнено:* ${monitoringConfig?.checkCount || 0}\n` +
        `⏳ *Последняя проверка:* ${monitoringConfig?.lastCheckTime || "только что"}`;

      await TelegramBot.sendMessage(tgToken, tgChatId, statusMsg);
    }
  }

  async function handleTelegramCallback(cb, store) {
    const { tgToken, tgChatId, appointments, monitoringConfig } = store;
    const action = cb.data;
    const msgId = cb.message?.message_id;

    if (action === "shift_confirm") {
      await TelegramBot.answerCallbackQuery(tgToken, cb.id, "Выполняется бронирование слота...");

      if (!pendingSlotToShift) {
        await TelegramBot.editMessageText(tgToken, tgChatId, msgId, "⚠️ Время ожидания подтверждения истекло или слот не найден. Мониторинг продолжается.");
        return;
      }

      await TelegramBot.editMessageText(tgToken, tgChatId, msgId, `⏳ Бронируем слот: *${pendingSlotToShift.formattedFull}*...`);

      const appt = appointments?.find(a => String(a.id) === String(monitoringConfig?.appointmentId)) || appointments?.[0];
      try {
        await performShift(appt, pendingSlotToShift);
        playSuccessChime();
        await stopMonitoring();

        await addLog(`🎉 Успешно перенесено на ${pendingSlotToShift.formattedFull}!`, "success");
        await TelegramBot.editMessageText(tgToken, tgChatId, msgId, `🎉 *Запись успешно перенесена!*\n\n🕒 Новое время: *${pendingSlotToShift.formattedFull}*\n🩺 Врач/Кабинет: ${pendingSlotToShift.doctorName || pendingSlotToShift.cabinet}\n🏥 Место: ${pendingSlotToShift.lpuName}`);
        pendingSlotToShift = null;
      } catch (err) {
        await addLog(`⚠️ Ошибка бронирования: ${err.message}`, "error");
        await TelegramBot.editMessageText(tgToken, tgChatId, msgId, `⚠️ *Слот не удалось занять*: ${err.message}.\nПродолжаю поиск других слотов...`);
        pendingSlotToShift = null;
        scheduleNextCycle(10);
      }
    } else if (action === "shift_skip") {
      await TelegramBot.answerCallbackQuery(tgToken, cb.id, "Слот пропущен");
      await TelegramBot.editMessageText(tgToken, tgChatId, msgId, "❌ Слот пропущен. Продолжаем поиск подходящего времени...");
      pendingSlotToShift = null;
      scheduleNextCycle(10);
    } else if (action === "shift_stop") {
      await TelegramBot.answerCallbackQuery(tgToken, cb.id, "Мониторинг остановлен");
      await stopMonitoring();
      await addLog("⏹️ Мониторинг остановлен из Telegram", "stop");
      await TelegramBot.editMessageText(tgToken, tgChatId, msgId, "⏹️ Мониторинг остановлен.");
      pendingSlotToShift = null;
    }
  }

  // -------------------------------------------------------------
  // Monitoring Engine (Auto-Sniper / Semi-Auto)
  // -------------------------------------------------------------
  async function runMonitoringCycle() {
    const store = await chrome.storage.local.get(["monitoringActive", "monitoringConfig", "appointments", "tgToken", "tgChatId", "transferMode"]);
    if (!store.monitoringActive || !store.monitoringConfig) {
      stopMonitoring();
      return;
    }

    const config = store.monitoringConfig;
    const appointments = store.appointments || [];
    const appointment = appointments.find(a => String(a.id) === String(config.appointmentId)) || appointments[0];
    const transferMode = store.transferMode || "semi";

    if (!appointment) {
      await addLog("⚠️ Запись для переноса не найдена в списке активных", "error");
      scheduleNextCycle(30);
      return;
    }

    const checkCount = (config.checkCount || 0) + 1;
    config.checkCount = checkCount;
    config.lastCheckTime = new Date().toLocaleTimeString();
    await chrome.storage.local.set({ monitoringConfig: config });

    updateStatusUi(`Проверка №${checkCount}... Запрос расписания`);

    try {
      const targetDateStr = config.targetDatetime ? config.targetDatetime.split("T")[0] : "";
      const slots = await fetchAvailableSchedule(appointment, targetDateStr);

      const matched = findBestSlots(slots, config.targetDatetime, {
        windowMinutes: config.timeWindow === "any" ? null : parseInt(config.timeWindow, 10),
        onlyTargetDate: true
      });

      console.log(`[EMIAS Monitoring #${checkCount}] Всего слотов: ${slots.length}, подходящих: ${matched.length}`);

      if (matched.length > 0) {
        const bestSlot = matched[0];

        // 1. SEMI-AUTO MODE (Default): Ask via interactive Telegram button
        if (transferMode === "semi" && store.tgToken && store.tgChatId) {
          pendingSlotToShift = bestSlot;
          await addLog(`🎯 Найден слот ${bestSlot.formattedFull} (Δ ${bestSlot.absDiffMinutes} мин). Запрос подтверждения отправлен в Telegram`, "match");
          updateStatusUi(`🎯 Найден слот ${bestSlot.formattedTime}! Ожидание подтверждения в Telegram...`);

          const promptText = `🔔 *Найден подходящий талон в ЕМИАС!*\n\n` +
            `📋 *Запись:* [${appointment.number || ""}] ${appointment.toBM ? appointment.toBM.name : (appointment.specialityName || "Приём")}\n` +
            `🩺 *Врач/Кабинет:* ${bestSlot.doctorName || bestSlot.cabinet || "Врач"}\n` +
            `🏥 *Место:* ${bestSlot.lpuName}\n` +
            `🕒 *Новое время:* *${bestSlot.formattedFull}*\n` +
            `*(отклонение: ${bestSlot.absDiffMinutes} мин от желаемого)*\n\n` +
            `Нажмите кнопку ниже для подтверждения:`;

          const keyboard = {
            inline_keyboard: [
              [{ text: `✅ Перенести на ${bestSlot.formattedTime}`, callback_data: "shift_confirm" }],
              [{ text: "❌ Пропустить этот слот", callback_data: "shift_skip" }],
              [{ text: "⏹️ Прекратить поиск", callback_data: "shift_stop" }]
            ]
          };

          await TelegramBot.sendMessage(store.tgToken, store.tgChatId, promptText, { replyMarkup: keyboard });
          scheduleNextCycle(90);
          return;
        }

        // 2. FULL-AUTO MODE: shift immediately
        updateStatusUi(`🎯 Автоперенос: найден слот ${bestSlot.formattedFull}. Бронируем...`);
        try {
          await performShift(appointment, bestSlot);
          playSuccessChime();
          await stopMonitoring();

          await addLog(`🎉 Успешно перенесено на ${bestSlot.formattedFull}!`, "success");
          updateStatusUi(`🎉 Запись перенесена на ${bestSlot.formattedFull}!`, true);

          if (store.tgToken && store.tgChatId) {
            await TelegramBot.sendMessage(store.tgToken, store.tgChatId,
              `🎉 *Запись успешно перенесена!*\n\n📋 Номер: ${appointment.number || ""}\n🩺 Врач/Кабинет: ${bestSlot.doctorName || bestSlot.cabinet || ""}\n🏥 Место: ${bestSlot.lpuName}\n🕒 Время: *${bestSlot.formattedFull}*`
            );
          }
          return;
        } catch (shiftErr) {
          await addLog(`⚠️ Слот перехвачен: ${shiftErr.message}`, "error");
          updateStatusUi(`⚠️ Слот перехвачен. Продолжаем поиск...`);
        }
      } else {
        await addLog(`Проверка #${checkCount}: проверено слотов: ${slots.length}. Подходящих пока нет.`, "info");
        updateStatusUi(`Проверка #${checkCount}: подходящих слотов пока нет. Ждём отмен...`);
      }
    } catch (err) {
      await addLog(`Ошибка проверки: ${err.message}`, "error");
      updateStatusUi(`Ошибка проверки: ${err.message}`);
    }

    // Next cycle with random jitter (22 - 33 seconds)
    const jitterSeconds = 22 + Math.floor(Math.random() * 12);
    scheduleNextCycle(jitterSeconds);
  }

  function scheduleNextCycle(delaySeconds) {
    if (monitoringTimer) clearTimeout(monitoringTimer);
    if (countdownTimer) clearInterval(countdownTimer);

    nextCheckTimestamp = Date.now() + delaySeconds * 1000;

    countdownTimer = setInterval(() => {
      const remaining = Math.max(0, Math.round((nextCheckTimestamp - Date.now()) / 1000));
      updateCountdownUi(remaining);
      if (remaining <= 0) {
        clearInterval(countdownTimer);
      }
    }, 1000);

    monitoringTimer = setTimeout(runMonitoringCycle, delaySeconds * 1000);
  }

  async function stopMonitoring() {
    if (monitoringTimer) clearTimeout(monitoringTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    monitoringTimer = null;
    countdownTimer = null;
    isTgPollingActive = false;
    pendingSlotToShift = null;

    setUnloadProtection(false);

    const store = await chrome.storage.local.get("monitoringConfig");
    const config = store.monitoringConfig || {};
    config.active = false;
    await chrome.storage.local.set({
      monitoringActive: false,
      monitoringConfig: config
    });

    chrome.runtime.sendMessage({ type: "UPDATE_MONITOR_BADGE", active: false });
    renderFloatingUi();
  }

  // -------------------------------------------------------------
  // In-Page Floating UI & Indicators
  // -------------------------------------------------------------
  function updateFloatingCounter(count) {
    const counterEl = document.getElementById("emias-req-counter");
    if (counterEl) {
      counterEl.innerText = `${count} запросов`;
    }
  }

  function updateStatusUi(text, isSuccess = false) {
    const statusEl = document.getElementById("emias-monitor-status");
    if (statusEl) {
      statusEl.innerText = text;
      statusEl.style.color = isSuccess ? "#16a34a" : "#2d3748";
    }
  }

  function updateCountdownUi(seconds) {
    const cdEl = document.getElementById("emias-monitor-countdown");
    if (cdEl) {
      cdEl.innerText = seconds > 0 ? `(след. через ${seconds}с)` : "";
    }
  }

  function renderMiniLogUi(logs) {
    const logContainer = document.getElementById("emias-mini-log");
    if (!logContainer) return;
    if (!logs || logs.length === 0) {
      logContainer.innerHTML = `<div style="color:#94a3b8;text-align:center;padding:8px;font-size:11px;">История действий пуста</div>`;
      return;
    }
    logContainer.innerHTML = logs.slice().reverse().slice(0, 8).map(l => {
      const color = l.type === "success" ? "#16a34a" : (l.type === "match" ? "#0284c7" : (l.type === "error" ? "#dc2626" : "#475569"));
      return `
        <div style="font-size: 11px; margin-bottom: 4px; line-height: 1.3; color: ${color}; border-bottom: 1px dashed #e2e8f0; padding-bottom: 3px;">
          <span style="color: #94a3b8; font-size: 10px;">${l.time}</span> ${l.text}
        </div>
      `;
    }).join("");
  }

  async function renderFloatingUi() {
    let container = document.getElementById("emias-assistant-root");
    if (!container) {
      container = document.createElement("div");
      container.id = "emias-assistant-root";
      document.body.appendChild(container);
    }

    const store = await chrome.storage.local.get([
      "monitoringActive",
      "monitoringConfig",
      "appointments",
      "patientContext",
      "monitoringLogs",
      "transferMode"
    ]);

    const isMonitoring = Boolean(store.monitoringActive);
    const appointments = store.appointments || [];
    const hasAppointments = appointments.length > 0;
    const transferMode = store.transferMode || "semi";

    const selectedApptId = store.monitoringConfig?.appointmentId || (appointments[0] ? appointments[0].id : null);
    const currentAppt = appointments.find(a => String(a.id) === String(selectedApptId)) || appointments[0] || null;

    container.innerHTML = `
      <style>
        @keyframes emiasPulse {
          0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
          70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
          100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
        }
        .emias-live-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #22c55e;
          display: inline-block;
          animation: emiasPulse 1.8s infinite;
        }
      </style>

      <div id="emias-badge-btn" style="
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 999999;
        background: ${isMonitoring ? "linear-gradient(135deg, #15803d, #166534)" : "linear-gradient(135deg, #00897B, #004D40)"};
        color: white;
        padding: 10px 16px;
        border-radius: 28px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        user-select: none;
      ">
        ${isMonitoring ? '<span class="emias-live-dot"></span>' : '<span style="font-size: 16px;">🩺</span>'}
        <span>${isMonitoring ? "Мониторинг активен" : "ЕМИАС Автоперенос"}</span>
        <span id="emias-req-counter" style="
          background: rgba(255, 255, 255, 0.25);
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 11px;
        ">${isMonitoring ? "Поиск..." : (hasAppointments ? `${appointments.length} зап.` : "Готов")}</span>
      </div>

      <div id="emias-drawer" style="
        display: none;
        position: fixed;
        bottom: 76px;
        right: 24px;
        width: 400px;
        max-height: 560px;
        background: #ffffff;
        color: #1e293b;
        border-radius: 14px;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.25);
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        overflow: hidden;
        border: 1px solid #e2e8f0;
        flex-direction: column;
      ">
        <div style="background: #00897B; color: white; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center;">
          <div style="font-weight: 700; display: flex; align-items: center; gap: 8px;">
            ${isMonitoring ? '<span class="emias-live-dot"></span>' : '<span>🩺</span>'}
            <span>ЕМИАС Автоперенос</span>
          </div>
          <button id="emias-drawer-close" style="background: none; border: none; color: white; cursor: pointer; font-size: 16px;">✕</button>
        </div>

        <div style="padding: 14px 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px;">
          <!-- Closing tab warning notice -->
          <div style="background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px; padding: 8px 10px; font-size: 11px; color: #92400e; display: flex; gap: 6px; align-items: center;">
            <span>💡</span>
            <span>Для работы автопоиска держите вкладку ЕМИАС открытой (её можно свернуть).</span>
          </div>

          <!-- Status Banner -->
          <div style="background: ${isMonitoring ? "#f0fdf4" : "#f8fafc"}; border: 1px solid ${isMonitoring ? "#bbf7d0" : "#e2e8f0"}; border-radius: 8px; padding: 10px 12px;">
            <div style="display: flex; justify-content: space-between; font-weight: 600; font-size: 12px; margin-bottom: 4px;">
              <span style="display:flex; align-items:center; gap:6px;">
                ${isMonitoring ? '<span class="emias-live-dot"></span>' : '<span>⚪</span>'}
                <span>Статус: ${isMonitoring ? "Автопоиск запущен" : "Ожидание"}</span>
              </span>
              <span id="emias-monitor-countdown" style="color: #64748b; font-weight: normal;"></span>
            </div>
            <div id="emias-monitor-status" style="font-size: 11px; color: #475569; line-height: 1.3;">
              ${isMonitoring ? "Отслеживание слотов в процессе..." : "Выберите параметры и нажмите «Запустить автопоиск»"}
            </div>
          </div>

          <!-- Rich Appointment Card -->
          ${currentAppt ? `
            <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px 12px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <span style="font-size: 10px; font-weight: 700; color: #00897B; background: #e6fffa; padding: 1px 6px; border-radius: 4px;">${currentAppt.number || "АКТИВНАЯ ЗАПИСЬ"}</span>
                <span style="font-size: 10px; color: #64748b;">${appointments.length > 1 ? `1 из ${appointments.length} записей` : ""}</span>
              </div>
              <div style="font-weight: 700; font-size: 13px; color: #0f172a; margin-bottom: 4px;">
                🩺 ${currentAppt.toBM ? currentAppt.toBM.name : (currentAppt.specialityName || "Приём")}
              </div>
              <div style="font-size: 11px; color: #334155; margin-bottom: 2px;">
                📅 <b>${new Date(currentAppt.startTime).toLocaleDateString("ru-RU")} в ${new Date(currentAppt.startTime).toLocaleTimeString("ru-RU", {hour:"2-digit",minute:"2-digit"})}</b>
              </div>
              <div style="font-size: 11px; color: #64748b;">
                📍 ${currentAppt.nameLpu} (${currentAppt.roomNumber || ""})
              </div>
            </div>
          ` : `
            <div style="color: #64748b; font-size: 11px; text-align: center; padding: 8px;">Ожидание загрузки записей...</div>
          `}

          <!-- Hidden select for form value -->
          <input type="hidden" id="emias-appt-select" value="${currentAppt ? currentAppt.id : ""}">

          <!-- Target datetime -->
          <div>
            <label style="display: block; font-weight: 600; font-size: 11px; margin-bottom: 3px;">Желаемое время приёма:</label>
            <input type="datetime-local" id="emias-target-dt" style="width: 100%; padding: 7px 9px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 12px; box-sizing: border-box;" value="${store.monitoringConfig?.targetDatetime || ""}">
          </div>

          <!-- Tolerance window & mode -->
          <div style="display: flex; gap: 8px;">
            <div style="flex: 1;">
              <label style="display: block; font-weight: 600; font-size: 11px; margin-bottom: 3px;">Окно времени:</label>
              <select id="emias-window-select" style="width: 100%; padding: 6px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 12px;">
                <option value="15">±15 минут</option>
                <option value="30">±30 минут</option>
                <option value="60" selected>±1 час</option>
                <option value="120">±2 часа</option>
                <option value="any">Весь день</option>
              </select>
            </div>
            <div style="flex: 1;">
              <label style="display: block; font-weight: 600; font-size: 11px; margin-bottom: 3px;">Режим бронирования:</label>
              <select id="emias-mode-select" style="width: 100%; padding: 6px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 12px; font-weight: 600; color: #00897B;">
                <option value="semi" ${transferMode === "semi" ? "selected" : ""}>📲 Полуавтомат (кнопка в TG)</option>
                <option value="auto" ${transferMode === "auto" ? "selected" : ""}>⚡ Полный автомат</option>
              </select>
            </div>
          </div>

          <!-- Found Slots Preview -->
          <div id="emias-slots-preview" style="display: none; background: #f1f5f9; border-radius: 8px; padding: 8px; max-height: 120px; overflow-y: auto;"></div>

          <!-- Actions -->
          <div style="display: flex; gap: 8px;">
            <button id="emias-find-btn" style="flex: 1; background: #e2e8f0; color: #1e293b; border: none; padding: 9px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 12px;">
              🔍 Проверить сейчас
            </button>
            <button id="emias-toggle-monitor-btn" style="flex: 1.2; background: ${isMonitoring ? "#dc2626" : "#00897B"}; color: white; border: none; padding: 9px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 12px;">
              ${isMonitoring ? "⏹️ Остановить поиск" : "🚀 Запустить автопоиск"}
            </button>
          </div>

          <!-- Mini Log -->
          <div>
            <div style="font-weight: 600; font-size: 11px; color: #64748b; margin-bottom: 4px; display: flex; justify-content: space-between;">
              <span>История проверок (Mini-Log):</span>
              <span style="font-size: 10px; cursor: pointer; color: #00897B;" id="emias-clear-log-btn">Очистить</span>
            </div>
            <div id="emias-mini-log" style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 8px; max-height: 90px; overflow-y: auto;"></div>
          </div>
        </div>
      </div>
    `;

    renderMiniLogUi(store.monitoringLogs || []);

    // Bind events
    const badgeBtn = document.getElementById("emias-badge-btn");
    const drawer = document.getElementById("emias-drawer");
    const closeBtn = document.getElementById("emias-drawer-close");
    const findBtn = document.getElementById("emias-find-btn");
    const toggleBtn = document.getElementById("emias-toggle-monitor-btn");
    const apptSelect = document.getElementById("emias-appt-select");
    const targetDtInput = document.getElementById("emias-target-dt");
    const windowSelect = document.getElementById("emias-window-select");
    const modeSelect = document.getElementById("emias-mode-select");
    const previewContainer = document.getElementById("emias-slots-preview");
    const clearLogBtn = document.getElementById("emias-clear-log-btn");

    badgeBtn.addEventListener("click", () => {
      drawer.style.display = drawer.style.display === "none" ? "flex" : "none";
    });

    closeBtn.addEventListener("click", () => {
      drawer.style.display = "none";
    });

    modeSelect.addEventListener("change", async (e) => {
      await chrome.storage.local.set({ transferMode: e.target.value });
    });

    clearLogBtn?.addEventListener("click", async () => {
      await chrome.storage.local.set({ monitoringLogs: [] });
      renderMiniLogUi([]);
    });

    findBtn.addEventListener("click", async () => {
      findBtn.disabled = true;
      findBtn.innerText = "Поиск...";
      previewContainer.style.display = "block";
      previewContainer.innerHTML = `<div style="text-align:center;color:#64748b;padding:8px;">Запрос расписания...</div>`;

      try {
        const apptId = apptSelect.value;
        const appt = appointments.find(a => String(a.id) === String(apptId)) || appointments[0];
        const targetDt = targetDtInput.value;

        if (!targetDt) {
          alert("Укажите желаемую дату и время");
          return;
        }

        const slots = await fetchAvailableSchedule(appt, targetDt.split("T")[0]);
        const matched = findBestSlots(slots, targetDt, {
          windowMinutes: windowSelect.value === "any" ? null : parseInt(windowSelect.value, 10),
          onlyTargetDate: true
        });

        if (matched.length === 0) {
          previewContainer.innerHTML = `<div style="text-align:center;color:#64748b;padding:8px;">На эту дату подходящих слотов не найдено (всего слотов: ${slots.length}).</div>`;
        } else {
          previewContainer.innerHTML = `
            <div style="font-weight:600;font-size:11px;margin-bottom:6px;color:#0f172a;">Найдено ${matched.length} слотов:</div>
            ${matched.slice(0, 5).map((s, idx) => `
              <div style="display:flex;justify-content:space-between;align-items:center;background:white;padding:6px 8px;border-radius:6px;margin-bottom:4px;font-size:11px;border:1px solid #e2e8f0;">
                <div>
                  <b>${s.formattedTime}</b> (${s.formattedDate})
                  <div style="font-size:10px;color:#64748b;">${s.doctorName || s.cabinet || ""} · Δ ${s.absDiffMinutes} мин</div>
                </div>
                <button class="emias-shift-now-btn" data-idx="${idx}" style="background:#00897B;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;">
                  Перенести
                </button>
              </div>
            `).join("")}
          `;

          previewContainer.querySelectorAll(".emias-shift-now-btn").forEach(btn => {
            btn.addEventListener("click", async (e) => {
              const idx = parseInt(e.target.getAttribute("data-idx"), 10);
              const targetSlot = matched[idx];
              if (confirm(`Перенести запись на ${targetSlot.formattedFull}?`)) {
                btn.disabled = true;
                btn.innerText = "...";
                try {
                  await performShift(appt, targetSlot);
                  playSuccessChime();
                  await addLog(`Ручной перенос на ${targetSlot.formattedFull}`, "success");
                  alert(`✅ Запись успешно перенесена на ${targetSlot.formattedFull}!`);
                  drawer.style.display = "none";
                } catch (err) {
                  alert("Ошибка при переносе: " + err.message);
                }
              }
            });
          });
        }
      } catch (err) {
        previewContainer.innerHTML = `<div style="color:#dc2626;padding:8px;">Ошибка: ${err.message}</div>`;
      } finally {
        findBtn.disabled = false;
        findBtn.innerText = "🔍 Проверить сейчас";
      }
    });

    toggleBtn.addEventListener("click", async () => {
      if (isMonitoring) {
        await stopMonitoring();
        await addLog("⏹️ Мониторинг остановлен пользователем", "stop");
      } else {
        const apptId = apptSelect.value;
        const targetDt = targetDtInput.value;

        if (!targetDt) {
          alert("Укажите желаемое время для переноса");
          return;
        }

        const config = {
          appointmentId: apptId,
          targetDatetime: targetDt,
          timeWindow: windowSelect.value,
          anyDoctor: true,
          checkCount: 0
        };

        await chrome.storage.local.set({
          monitoringActive: true,
          monitoringConfig: config,
          transferMode: modeSelect.value
        });

        setUnloadProtection(true);
        chrome.runtime.sendMessage({ type: "UPDATE_MONITOR_BADGE", active: true });

        // Send start notification to Telegram with control keyboard
        const tgData = await chrome.storage.local.get(["tgToken", "tgChatId"]);
        if (tgData.tgToken && tgData.tgChatId) {
          const modeLabel = modeSelect.value === "semi" ? "📲 Полуавтомат (подтверждение кнопкой)" : "⚡ Полный автомат";
          const startMsg = `🚀 *Мониторинг ЕМИАС запущен!*\n\n` +
            `📋 *Запись:* ${currentAppt?.toBM ? currentAppt.toBM.name : (currentAppt?.specialityName || "Приём")}\n` +
            `🎯 *Целевое время:* ${new Date(targetDt).toLocaleString("ru-RU")}\n` +
            `⚙️ *Режим:* ${modeLabel}\n\n` +
            `Вы можете остановить поиск или запросить статус кнопками ниже:`;

          const keyboard = {
            keyboard: [
              [{ text: "📊 Проверить статус" }],
              [{ text: "⏹️ Прекратить поиск" }]
            ],
            resize_keyboard: true,
            persistent: true
          };

          await TelegramBot.sendMessage(tgData.tgToken, tgData.tgChatId, startMsg, { replyMarkup: keyboard });
          startTelegramPoller();
        }

        await addLog(`🚀 Запущен мониторинг (${modeSelect.value === "semi" ? "полуавтомат" : "полный автомат"})`, "info");
        renderFloatingUi();
        runMonitoringCycle();
      }
    });
  }

  // Auto-init
  window.addEventListener("DOMContentLoaded", renderFloatingUi);
  setTimeout(renderFloatingUi, 1500);

  // Resume active monitoring on page reload if previously enabled
  chrome.storage.local.get(["monitoringActive", "tgToken"]).then(store => {
    if (store.monitoringActive) {
      setUnloadProtection(true);
      if (store.tgToken) startTelegramPoller();
      setTimeout(runMonitoringCycle, 2000);
    }
  });

  // Message listener for commands from Popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "POPUP_SEARCH_SLOTS") {
      (async () => {
        try {
          const { appointmentId, targetDatetime, timeWindow, anyDoctor } = message.payload;
          const store = await chrome.storage.local.get("appointments");
          const appointments = store.appointments || [];
          const appt = appointments.find(a => String(a.id) === String(appointmentId)) || appointments[0];
          if (!appt) {
            sendResponse({ success: false, error: "Запись не найдена" });
            return;
          }

          const targetDateStr = targetDatetime.split("T")[0];
          const slots = await fetchAvailableSchedule(appt, targetDateStr);
          const matched = findBestSlots(slots, targetDatetime, {
            windowMinutes: timeWindow === "any" ? null : parseInt(timeWindow, 10),
            onlyTargetDate: true
          });

          sendResponse({ success: true, totalSlots: slots.length, matchedSlots: matched });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (message.type === "POPUP_EXECUTE_SHIFT") {
      (async () => {
        try {
          const { appointmentId, targetSlot } = message.payload;
          const store = await chrome.storage.local.get("appointments");
          const appointments = store.appointments || [];
          const appt = appointments.find(a => String(a.id) === String(appointmentId)) || appointments[0];

          await performShift(appt, targetSlot);
          playSuccessChime();
          await addLog(`Ручной перенос на ${targetSlot.formattedFull}`, "success");
          sendResponse({ success: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    if (message.type === "POPUP_START_MONITOR") {
      (async () => {
        await chrome.storage.local.set({
          monitoringActive: true,
          monitoringConfig: message.payload,
          transferMode: message.payload.transferMode || "semi"
        });
        setUnloadProtection(true);
        chrome.runtime.sendMessage({ type: "UPDATE_MONITOR_BADGE", active: true });

        const tgData = await chrome.storage.local.get(["tgToken", "tgChatId", "appointments"]);
        if (tgData.tgToken && tgData.tgChatId) {
          const appt = tgData.appointments?.find(a => String(a.id) === String(message.payload.appointmentId)) || tgData.appointments?.[0];
          const modeLabel = message.payload.transferMode === "semi" ? "📲 Полуавтомат (подтверждение кнопкой)" : "⚡ Полный автомат";
          const startMsg = `🚀 *Мониторинг ЕМИАС запущен!*\n\n` +
            `📋 *Запись:* ${appt?.toBM ? appt.toBM.name : (appt?.specialityName || "Приём")}\n` +
            `🎯 *Целевое время:* ${new Date(message.payload.targetDatetime).toLocaleString("ru-RU")}\n` +
            `⚙️ *Режим:* ${modeLabel}\n\n` +
            `Вы можете остановить поиск или запросить статус кнопками ниже:`;

          const keyboard = {
            keyboard: [
              [{ text: "📊 Проверить статус" }],
              [{ text: "⏹️ Прекратить поиск" }]
            ],
            resize_keyboard: true,
            persistent: true
          };

          await TelegramBot.sendMessage(tgData.tgToken, tgData.tgChatId, startMsg, { replyMarkup: keyboard });
          startTelegramPoller();
        }

        await addLog("🚀 Мониторинг запущен из Popup", "info");
        runMonitoringCycle();
        renderFloatingUi();
        sendResponse({ success: true });
      })();
      return true;
    }

    if (message.type === "POPUP_STOP_MONITOR") {
      (async () => {
        await stopMonitoring();
        await addLog("⏹️ Мониторинг остановлен из Popup", "stop");
        chrome.runtime.sendMessage({ type: "UPDATE_MONITOR_BADGE", active: false });
        renderFloatingUi();
        sendResponse({ success: true });
      })();
      return true;
    }

    return false;
  });
})();
