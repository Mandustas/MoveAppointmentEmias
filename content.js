// Content Script (Isolated World)
(() => {
  let capturedCount = 0;
  let monitoringTimer = null;
  let countdownTimer = null;
  let nextCheckTimestamp = 0;

  // Sound chime synthesizer (Web Audio API)
  function playSuccessChime() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
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

    // Handle command replies
    if (reqId && pendingRequests.has(reqId)) {
      const req = pendingRequests.get(reqId);
      clearTimeout(req.timer);
      pendingRequests.delete(reqId);

      if (error) {
        req.reject(new Error(error));
      } else {
        req.resolve(data);
      }
      return;
    }

    // Handle patient data auto-sync
    if (type === "PATIENT_DATA_RECEIVED" && payload) {
      console.log("%c[EMIAS Assistant]%c Данные пациента и записей синхронизированы!", "background:#00897B;color:white;padding:2px 6px;border-radius:3px;", "color:#00897B;font-weight:bold;");
      await chrome.storage.local.set({
        patientContext: payload.patientContext,
        appointments: payload.appointments,
        lastAppointmentsSync: Date.now()
      });
      renderFloatingUi();
    }

    // Handle doctors/resources info auto-sync
    if (type === "DOCTORS_INFO_RECEIVED" && payload) {
      const { appointmentId, doctorsInfo } = payload;
      const stored = await chrome.storage.local.get("doctorsInfoMap");
      const map = stored.doctorsInfoMap || {};
      map[appointmentId] = doctorsInfo;
      await chrome.storage.local.set({ doctorsInfoMap: map });
    }

    // Handle sniffer captured requests
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
  // High-level API methods
  // -------------------------------------------------------------
  async function fetchAvailableSchedule(appointment, targetDateStr) {
    const store = await chrome.storage.local.get(["patientContext", "doctorsInfoMap", "monitoringConfig"]);
    const patientContext = store.patientContext;
    if (!patientContext || !patientContext.omsNumber) {
      throw new Error("Нет контекста пациента. Обновите страницу ЕМИАС.");
    }

    const doctorsMap = store.doctorsInfoMap || {};
    const doctorsInfoList = doctorsMap[appointment.id] || [];

    // Date range: 3 days around target date or min-max
    const targetD = new Date(targetDateStr);
    const fromD = new Date(targetD);
    fromD.setDate(fromD.getDate() - 1);
    const toD = new Date(targetD);
    toD.setDate(toD.getDate() + 3);

    const dateFrom = fromD.toISOString().split("T")[0];
    const dateTo = toD.toISOString().split("T")[0];

    const resourcesToQuery = [];

    // Always include current appointment resource
    resourcesToQuery.push({
      availableResourceId: appointment.availableResourceId,
      complexResourceId: appointment.complexResourceId,
      lpuId: appointment.lpuId,
      lpuName: appointment.nameLpu,
      name: appointment.roomNumber || ""
    });

    // If anyDoctor is true, add other branches/resources if discovered
    const config = store.monitoringConfig || {};
    if (config.anyDoctor && doctorsInfoList.length > 0) {
      for (const doc of doctorsInfoList) {
        if (Array.isArray(doc.availableResources)) {
          for (const res of doc.availableResources) {
            if (res.id !== appointment.availableResourceId) {
              const compId = (res.complexResource && res.complexResource[0] && res.complexResource[0].id) || appointment.complexResourceId;
              resourcesToQuery.push({
                availableResourceId: res.id,
                complexResourceId: compId,
                lpuId: doc.lpuId,
                lpuName: doc.lpuShortName || doc.defaultAddress,
                name: res.name
              });
            }
          }
        }
      }
    }

    let allSlots = [];

    for (const resInfo of resourcesToQuery) {
      try {
        const payload = {
          appointmentId: appointment.id,
          availableResourceId: resInfo.availableResourceId,
          complexResourceId: resInfo.complexResourceId,
          omsNumber: patientContext.omsNumber,
          birthDate: patientContext.birthDate,
          period: { dateFrom, dateTo }
        };

        const res = await executeBridgeCmd("CMD_GET_SCHEDULE", payload);
        if (res && res.payload && res.payload.scheduleOfDay) {
          const slots = extractSlotsFromSchedule(res.payload.scheduleOfDay, resInfo);
          allSlots = allSlots.concat(slots);
        }
      } catch (err) {
        console.warn("[EMIAS] Ошибка получения расписания для ресурса:", resInfo.availableResourceId, err);
      }
    }

    return allSlots;
  }

  async function performShift(appointment, targetSlot) {
    const store = await chrome.storage.local.get("patientContext");
    const patientContext = store.patientContext;
    if (!patientContext) throw new Error("Нет контекста пациента");

    const payload = {
      appointmentId: appointment.id,
      availableResourceId: targetSlot.availableResourceId || appointment.availableResourceId,
      complexResourceId: targetSlot.complexResourceId || appointment.complexResourceId,
      startTime: targetSlot.startTime,
      endTime: targetSlot.endTime,
      omsNumber: patientContext.omsNumber,
      birthDate: patientContext.birthDate
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
  // Monitoring Engine (Auto-Sniper)
  // -------------------------------------------------------------
  async function runMonitoringCycle() {
    const store = await chrome.storage.local.get(["monitoringActive", "monitoringConfig", "appointments"]);
    if (!store.monitoringActive || !store.monitoringConfig) {
      stopMonitoring();
      return;
    }

    const config = store.monitoringConfig;
    const appointments = store.appointments || [];
    const appointment = appointments.find(a => String(a.id) === String(config.appointmentId)) || appointments[0];

    if (!appointment) {
      console.warn("[EMIAS Assistant] Запись для переноса не найдена в списке активных");
      scheduleNextCycle(30);
      return;
    }

    const checkCount = (config.checkCount || 0) + 1;
    config.checkCount = checkCount;
    config.lastCheckTime = new Date().toLocaleTimeString();
    await chrome.storage.local.set({ monitoringConfig: config });

    updateStatusUi(`Проверка №${checkCount}... Запрос расписания`);

    try {
      const targetDateStr = config.targetDatetime.split("T")[0];
      const slots = await fetchAvailableSchedule(appointment, targetDateStr);

      const matched = findBestSlots(slots, config.targetDatetime, {
        windowMinutes: config.timeWindow === "any" ? null : parseInt(config.timeWindow, 10),
        onlyTargetDate: true
      });

      console.log(`[EMIAS Monitoring #${checkCount}] Найдено слотов: ${slots.length}, подходящих: ${matched.length}`);

      if (matched.length > 0) {
        const bestSlot = matched[0];
        updateStatusUi(`🎯 Найден слот: ${bestSlot.formattedFull} (дельта: ${bestSlot.absDiffMinutes} мин). Переносим...`);

        try {
          const shiftRes = await performShift(appointment, bestSlot);

          // SUCCESS!
          playSuccessChime();
          await stopMonitoring();

          const successMsg = `🎉 Запись успешно перенесена!\nНовое время: ${bestSlot.formattedFull}\nМесто: ${bestSlot.lpuName} (${bestSlot.cabinet || ""})`;
          updateStatusUi(successMsg, true);

          // Dispatch Telegram notification
          chrome.runtime.sendMessage({
            type: "SEND_TELEGRAM_NOTIFICATION",
            payload: {
              title: "🎉 Запись в ЕМИАС перенесена!",
              text: `✅ Запись успешно перенесена!\n\n📋 Номер: ${appointment.number || ""}\n🩺 Врач/Кабинет: ${bestSlot.doctorName || bestSlot.cabinet || ""}\n🏥 Место: ${bestSlot.lpuName}\n🕒 Время: *${bestSlot.formattedFull}*\n(отклонение от желаемого: ${bestSlot.absDiffMinutes} мин)`
            }
          });

          // Refresh appointments list on page
          setTimeout(() => {
            executeBridgeCmd("CMD_REFRESH_APPOINTMENTS", {
              omsNumber: store.patientContext.omsNumber,
              birthDate: store.patientContext.birthDate,
              patientId: store.patientContext.patientId
            });
          }, 2000);

          return;
        } catch (shiftErr) {
          console.error("[EMIAS] Ошибка при бронировании слота:", shiftErr);
          updateStatusUi(`⚠️ Слот перехвачен или ошибка: ${shiftErr.message}. Продолжаем поиск...`);
        }
      } else {
        updateStatusUi(`Проверка #${checkCount}: подходящих слотов пока нет. Ждём отмен...`);
      }
    } catch (err) {
      console.warn("[EMIAS Monitoring Error]", err);
      updateStatusUi(`Ошибка проверки: ${err.message}`);
    }

    // Schedule next cycle with random jitter (22 - 32 seconds)
    const jitterSeconds = 22 + Math.floor(Math.random() * 11);
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

    const store = await chrome.storage.local.get("monitoringConfig");
    const config = store.monitoringConfig || {};
    config.active = false;
    await chrome.storage.local.set({
      monitoringActive: false,
      monitoringConfig: config
    });

    renderFloatingUi();
  }

  // -------------------------------------------------------------
  // In-Page Floating UI
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
      "patientContext"
    ]);

    const isMonitoring = Boolean(store.monitoringActive);
    const appointments = store.appointments || [];
    const hasAppointments = appointments.length > 0;

    container.innerHTML = `
      <div id="emias-badge-btn" style="
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 999999;
        background: ${isMonitoring ? "linear-gradient(135deg, #16a34a, #15803d)" : "linear-gradient(135deg, #00897B, #004D40)"};
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
        transition: transform 0.15s ease;
        user-select: none;
      ">
        <span style="font-size: 16px;">${isMonitoring ? "⚡" : "🩺"}</span>
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
        width: 380px;
        max-height: 520px;
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
          <div style="font-weight: 700; display: flex; align-items: center; gap: 6px;">
            <span>🩺</span> ЕМИАС Автоперенос
          </div>
          <button id="emias-drawer-close" style="background: none; border: none; color: white; cursor: pointer; font-size: 16px;">✕</button>
        </div>

        <div style="padding: 14px 16px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 12px;">
          <!-- Status Banner -->
          <div style="background: ${isMonitoring ? "#f0fdf4" : "#f8fafc"}; border: 1px solid ${isMonitoring ? "#bbf7d0" : "#e2e8f0"}; border-radius: 8px; padding: 10px 12px;">
            <div style="display: flex; justify-content: space-between; font-weight: 600; font-size: 12px; margin-bottom: 4px;">
              <span>Статус: ${isMonitoring ? "🟢 Автопоиск запущен" : "⚪ Ожидание"}</span>
              <span id="emias-monitor-countdown" style="color: #64748b; font-weight: normal;"></span>
            </div>
            <div id="emias-monitor-status" style="font-size: 11px; color: #475569; line-height: 1.3;">
              ${isMonitoring ? "Проверка слотов в процессе..." : "Выберите запись и время для переноса"}
            </div>
          </div>

          <!-- Appointments selector -->
          <div>
            <label style="display: block; font-weight: 600; font-size: 12px; margin-bottom: 4px;">Запись для переноса:</label>
            <select id="emias-appt-select" style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 12px; outline: none; background: white;">
              ${hasAppointments ? appointments.map(a => `
                <option value="${a.id}">
                  [${a.number || "Запись"}] ${a.toBM ? a.toBM.name : (a.specialityName || "Приём")} — ${new Date(a.startTime).toLocaleDateString("ru-RU")} ${new Date(a.startTime).toLocaleTimeString("ru-RU", {hour:"2-digit",minute:"2-digit"})}
                </option>
              `).join("") : `<option value="">Синхронизация записей...</option>`}
            </select>
          </div>

          <!-- Target datetime -->
          <div>
            <label style="display: block; font-weight: 600; font-size: 12px; margin-bottom: 4px;">Желаемое время приёма:</label>
            <input type="datetime-local" id="emias-target-dt" style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 12px; box-sizing: border-box;" value="${store.monitoringConfig?.targetDatetime || ""}">
          </div>

          <!-- Tolerance window -->
          <div style="display: flex; gap: 8px;">
            <div style="flex: 1;">
              <label style="display: block; font-weight: 600; font-size: 11px; margin-bottom: 4px;">Окно времени:</label>
              <select id="emias-window-select" style="width: 100%; padding: 6px 8px; border-radius: 6px; border: 1px solid #cbd5e1; font-size: 12px;">
                <option value="30">±30 минут</option>
                <option value="60" selected>±1 час</option>
                <option value="120">±2 часа</option>
                <option value="any">Весь день</option>
              </select>
            </div>
            <div style="flex: 1; display: flex; align-items: flex-end;">
              <label style="font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 4px; padding-bottom: 6px;">
                <input type="checkbox" id="emias-any-doc-cb" checked>
                <span>Любой врач/филиал</span>
              </label>
            </div>
          </div>

          <!-- Found Slots Preview Container -->
          <div id="emias-slots-preview" style="display: none; background: #f1f5f9; border-radius: 8px; padding: 8px; max-height: 140px; overflow-y: auto;"></div>

          <!-- Actions -->
          <div style="display: flex; gap: 8px; margin-top: 4px;">
            <button id="emias-find-btn" style="flex: 1; background: #e2e8f0; color: #1e293b; border: none; padding: 9px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 12px;">
              🔍 Проверить сейчас
            </button>
            <button id="emias-toggle-monitor-btn" style="flex: 1; background: ${isMonitoring ? "#dc2626" : "#00897B"}; color: white; border: none; padding: 9px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 12px;">
              ${isMonitoring ? "⏹️ Остановить" : "🚀 Запустить автопоиск"}
            </button>
          </div>
        </div>
      </div>
    `;

    // Bind events
    const badgeBtn = document.getElementById("emias-badge-btn");
    const drawer = document.getElementById("emias-drawer");
    const closeBtn = document.getElementById("emias-drawer-close");
    const findBtn = document.getElementById("emias-find-btn");
    const toggleBtn = document.getElementById("emias-toggle-monitor-btn");
    const apptSelect = document.getElementById("emias-appt-select");
    const targetDtInput = document.getElementById("emias-target-dt");
    const windowSelect = document.getElementById("emias-window-select");
    const anyDocCb = document.getElementById("emias-any-doc-cb");
    const previewContainer = document.getElementById("emias-slots-preview");

    badgeBtn.addEventListener("click", () => {
      drawer.style.display = drawer.style.display === "none" ? "flex" : "none";
    });

    closeBtn.addEventListener("click", () => {
      drawer.style.display = "none";
    });

    // 1-Click Search Now
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
          alert("Пожалуйста, укажите желаемую дату и время");
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
            <div style="font-weight:600;font-size:11px;margin-bottom:6px;color:#0f172a;">Найдено ${matched.length} слотов (показаны ближайшие):</div>
            ${matched.slice(0, 5).map((s, idx) => `
              <div style="display:flex;justify-content:space-between;align-items:center;background:white;padding:6px 8px;border-radius:6px;margin-bottom:4px;font-size:11px;border:1px solid #e2e8f0;">
                <div>
                  <b>${s.formattedTime}</b> (${s.formattedDate})
                  <div style="font-size:10px;color:#64748b;">${s.doctorName || s.cabinet || ""} · Дельта: ${s.absDiffMinutes} мин</div>
                </div>
                <button class="emias-shift-now-btn" data-idx="${idx}" style="background:#00897B;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;">
                  Перенести
                </button>
              </div>
            `).join("")}
          `;

          // Handle manual shift on click
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

    // Toggle Monitoring
    toggleBtn.addEventListener("click", async () => {
      if (isMonitoring) {
        await stopMonitoring();
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
          anyDoctor: anyDocCb.checked,
          checkCount: 0
        };

        await chrome.storage.local.set({
          monitoringActive: true,
          monitoringConfig: config
        });

        renderFloatingUi();
        runMonitoringCycle();
      }
    });
  }

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

          chrome.runtime.sendMessage({
            type: "SEND_TELEGRAM_NOTIFICATION",
            payload: {
              text: `🎉 Запись успешно перенесена!\n\n📋 Номер: ${appt.number || ""}\n🩺 Врач/Кабинет: ${targetSlot.doctorName || targetSlot.cabinet || ""}\n🏥 Место: ${targetSlot.lpuName}\n🕒 Время: *${targetSlot.formattedFull}*`
            }
          });

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
          monitoringConfig: message.payload
        });
        chrome.runtime.sendMessage({ type: "UPDATE_MONITOR_BADGE", active: true });
        runMonitoringCycle();
        renderFloatingUi();
        sendResponse({ success: true });
      })();
      return true;
    }

    if (message.type === "POPUP_STOP_MONITOR") {
      (async () => {
        await stopMonitoring();
        chrome.runtime.sendMessage({ type: "UPDATE_MONITOR_BADGE", active: false });
        renderFloatingUi();
        sendResponse({ success: true });
      })();
      return true;
    }

    return false;
  });

  // Auto-init
  window.addEventListener("DOMContentLoaded", renderFloatingUi);
  setTimeout(renderFloatingUi, 1500);

  // Resume active monitoring on page reload if previously enabled
  chrome.storage.local.get("monitoringActive").then(store => {
    if (store.monitoringActive) {
      setTimeout(runMonitoringCycle, 2000);
    }
  });
})();
