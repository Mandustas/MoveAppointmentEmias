// EMIAS Network Interceptor & API Bridge (MAIN execution world)
(() => {
  if (window.__EMIAS_INTERCEPTOR_INITIALIZED__) return;
  window.__EMIAS_INTERCEPTOR_INITIALIZED__ = true;
  window.__EMIAS_CAPTURED_API__ = window.__EMIAS_CAPTURED_API__ || [];
  window.__EMIAS_PATIENT__ = window.__EMIAS_PATIENT__ || null;

  console.log("%c[EMIAS Assistant]%c Сетевой мост и сниффер активированы", "background:#00897B;color:white;padding:2px 6px;border-radius:3px;font-weight:bold;", "color:#00897B;font-weight:bold;");

  const originalFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  // Scan localStorage and sessionStorage for patient context as instant fallback
  function scanStorageForPatient() {
    try {
      const storages = [window.localStorage, window.sessionStorage];
      for (const storage of storages) {
        if (!storage) continue;
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          const val = storage.getItem(key);
          if (!val || typeof val !== "string") continue;

          // Match birthDate or birthday or similar
          const bMatch = val.match(/"(?:birthDate|birthday|birth_date|dateOfBirth)"\s*:\s*"([^"]+)"/i);
          // Match omsNumber or oms
          const oMatch = val.match(/"(?:omsNumber|oms|policyNumber)"\s*:\s*"([^"]+)"/i);

          if (bMatch && oMatch && !bMatch[1].includes("REDACTED")) {
            window.__EMIAS_PATIENT__ = {
              birthDate: bMatch[1],
              omsNumber: oMatch[1]
            };
            window.postMessage({
              source: "EMIAS_INTERCEPTOR",
              type: "PATIENT_CONTEXT_SYNC",
              payload: window.__EMIAS_PATIENT__
            }, "*");
            console.log("%c[EMIAS Assistant]%c Пациент синхронизирован из хранилища браузера:", "background:#00897B;color:white;padding:2px 4px;font-weight:bold;", "color:#00897B;", window.__EMIAS_PATIENT__.omsNumber);
            return window.__EMIAS_PATIENT__;
          }
        }
      }
    } catch (e) {}
    return null;
  }
  scanStorageForPatient();
  // Also scan on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanStorageForPatient);
  }

  function sanitizeData(data, depth = 0) {
    if (depth > 6) return "...";
    if (data === null || data === undefined) return data;
    if (typeof data === "number" || typeof data === "boolean") return data;
    if (typeof data === "string") {
      if (data.length > 80 && !data.includes(" ") && !data.includes("/")) {
        return data.substring(0, 10) + "...[TRUNCATED_TOKEN]";
      }
      return data;
    }
    if (Array.isArray(data)) {
      if (data.length > 5) {
        const sample = data.slice(0, 3).map(item => sanitizeData(item, depth + 1));
        return { _type: "Array", totalCount: data.length, sampleItems: sample };
      }
      return data.map(item => sanitizeData(item, depth + 1));
    }
    if (typeof data === "object") {
      const sanitized = {};
      for (const [key, value] of Object.entries(data)) {
        if (/^(fio|fullName|surName|firstName|patronymic|birthDate|oms|polis|phone|email|snils|passport)$/i.test(key)) {
          sanitized[key] = "[REDACTED_FOR_PRIVACY]";
        } else {
          sanitized[key] = sanitizeData(value, depth + 1);
        }
      }
      return sanitized;
    }
    return data;
  }

  function shouldIntercept(url) {
    if (!url) return false;
    const lower = String(url).toLowerCase();
    return (
      lower.includes("/api/") ||
      lower.includes("/api-eip/") ||
      lower.includes("appointment") ||
      lower.includes("schedule") ||
      lower.includes("specialit") ||
      lower.includes("doctor") ||
      lower.includes("slot") ||
      lower.includes("shift") ||
      lower.includes("resource") ||
      lower.includes("einfo")
    );
  }

  function handleSpecializedApi(url, reqBody, resData) {
    // Whenever ANY /api-eip/ call has omsNumber and birthDate, save the REAL patientContext!
    if (reqBody && reqBody.omsNumber && reqBody.birthDate) {
      const bDate = String(reqBody.birthDate);
      const oms = String(reqBody.omsNumber);
      if (!bDate.includes("REDACTED")) {
        window.__EMIAS_PATIENT__ = {
          omsNumber: oms,
          birthDate: bDate,
          patientId: reqBody.patientId ? String(reqBody.patientId) : null
        };
        window.postMessage({
          source: "EMIAS_INTERCEPTOR",
          type: "PATIENT_CONTEXT_SYNC",
          payload: window.__EMIAS_PATIENT__
        }, "*");
      }
    }

    if (!resData || !resData.payload) return;

    if (url.includes("getAppointmentReceptionsByPatient")) {
      const appointments = resData.payload.appointment || [];
      window.postMessage({
        source: "EMIAS_INTERCEPTOR",
        type: "APPOINTMENTS_SYNC",
        payload: { appointments }
      }, "*");
    }

    if (url.includes("getDoctorsInfoForLI") || url.includes("getDoctorsInfo")) {
      const doctorsInfo = resData.payload.doctorsInfo || [];
      const appointmentId = reqBody?.appointmentId || null;
      window.postMessage({
        source: "EMIAS_INTERCEPTOR",
        type: "DOCTORS_INFO_SYNC",
        payload: { appointmentId, doctorsInfo }
      }, "*");
    }

    if (url.includes("getAvailableResourceScheduleInfo")) {
      console.log("%c[EMIAS Assistant] Зафиксирован реальный вызов расписания ЕМИАС:%c", "color:#0284c7;font-weight:bold;", "", {
        request: reqBody,
        response: resData
      });
    }
  }

  function broadcastCaptured(apiRecord) {
    window.__EMIAS_CAPTURED_API__.push(apiRecord);
    if (window.__EMIAS_CAPTURED_API__.length > 100) {
      window.__EMIAS_CAPTURED_API__.shift();
    }

    window.postMessage({
      source: "EMIAS_INTERCEPTOR",
      type: "API_CAPTURED",
      payload: apiRecord
    }, "*");
  }

  // Intercept Fetch
  window.fetch = async function(...args) {
    const resource = args[0];
    const init = args[1] || {};
    const url = typeof resource === "string" ? resource : (resource ? resource.url : "");
    const method = (init.method || (resource && resource.method) || "GET").toUpperCase();

    let requestBody = null;
    if (init.body) {
      try {
        requestBody = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      } catch (e) {
        requestBody = init.body;
      }
    }

    const response = await originalFetch.apply(this, args);

    if (shouldIntercept(url)) {
      try {
        const clone = response.clone();
        clone.text().then(text => {
          let responseJson = null;
          try {
            responseJson = JSON.parse(text);
            handleSpecializedApi(url, requestBody, responseJson);
          } catch (e) {
            responseJson = text.substring(0, 300);
          }

          const apiRecord = {
            id: "req_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
            timestamp: new Date().toLocaleTimeString(),
            method: method,
            url: url,
            status: response.status,
            requestBody: sanitizeData(requestBody),
            responseBody: sanitizeData(responseJson)
          };

          broadcastCaptured(apiRecord);
        }).catch(err => {});
      } catch (err) {}
    }

    return response;
  };

  // Intercept XHR
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._interceptedUrl = url;
    this._interceptedMethod = method ? method.toUpperCase() : "GET";
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (shouldIntercept(this._interceptedUrl)) {
      const url = this._interceptedUrl;
      const method = this._interceptedMethod;
      let requestBody = null;
      if (body) {
        try {
          requestBody = typeof body === "string" ? JSON.parse(body) : body;
        } catch (e) {
          requestBody = body;
        }
      }

      this.addEventListener("load", function() {
        let responseJson = null;
        try {
          responseJson = JSON.parse(this.responseText);
          handleSpecializedApi(url, requestBody, responseJson);
        } catch (e) {
          responseJson = (this.responseText || "").substring(0, 300);
        }

        const apiRecord = {
          id: "req_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
          timestamp: new Date().toLocaleTimeString(),
          method: method,
          url: url,
          status: this.status,
          requestBody: sanitizeData(requestBody),
          responseBody: sanitizeData(responseJson)
        };

        broadcastCaptured(apiRecord);
      });
    }

    return origSend.call(this, body);
  };

  // -------------------------------------------------------------
  // Command execution bridge
  // -------------------------------------------------------------
  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== "EMIAS_EXTENSION_CONTENT") {
      return;
    }

    const { action, reqId, payload } = event.data;

    try {
      if (action === "CMD_GET_SCHEDULE") {
        if (!window.__EMIAS_PATIENT__) {
          scanStorageForPatient();
        }
        // Fallback for birthDate / omsNumber if missing or redacted in payload
        if ((!payload.birthDate || payload.birthDate === "undefined" || payload.birthDate.includes("REDACTED")) && window.__EMIAS_PATIENT__) {
          payload.birthDate = window.__EMIAS_PATIENT__.birthDate;
        }
        if ((!payload.omsNumber || payload.omsNumber === "undefined" || payload.omsNumber.includes("REDACTED")) && window.__EMIAS_PATIENT__) {
          payload.omsNumber = window.__EMIAS_PATIENT__.omsNumber;
        }

        const res = await originalFetch("/api-eip/v4/saOrchestrator/getAvailableResourceScheduleInfo", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        let data = null;
        try {
          data = await res.json();
        } catch (e) {
          data = await res.text();
        }

        if (!res.ok) {
          const errStr = typeof data === "object" ? JSON.stringify(data) : String(data);
          const payloadStr = JSON.stringify(payload);
          console.error("%c[EMIAS 400 REASON]:%c " + errStr, "background:#dc2626;color:white;font-weight:bold;padding:2px 4px;", "color:#dc2626;font-weight:bold;");
          console.error("%c[EMIAS SENT PAYLOAD]:%c " + payloadStr, "background:#475569;color:white;padding:2px 4px;", "color:#334155;");
        }

        window.postMessage({
          source: "EMIAS_INTERCEPTOR",
          action: "RES_GET_SCHEDULE",
          reqId,
          status: res.status,
          data: res.ok ? data : null,
          error: res.ok ? null : (typeof data === "object" ? JSON.stringify(data) : (data || `Ошибка ${res.status}`))
        }, "*");
      } else if (action === "CMD_SHIFT_APPOINTMENT") {
        console.log("%c[EMIAS Assistant]%c Выполняется перенос записи...", "background:#16a34a;color:white;padding:2px 6px;font-weight:bold;", "color:#16a34a;font-weight:bold;", payload);
        if (!window.__EMIAS_PATIENT__) {
          scanStorageForPatient();
        }
        if ((!payload.birthDate || payload.birthDate === "undefined" || payload.birthDate.includes("REDACTED")) && window.__EMIAS_PATIENT__) {
          payload.birthDate = window.__EMIAS_PATIENT__.birthDate;
        }
        if ((!payload.omsNumber || payload.omsNumber === "undefined" || payload.omsNumber.includes("REDACTED")) && window.__EMIAS_PATIENT__) {
          payload.omsNumber = window.__EMIAS_PATIENT__.omsNumber;
        }

        const res = await originalFetch("/api-eip/v4/saOrchestrator/shiftAppointment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        let data = null;
        try {
          data = await res.json();
        } catch (e) {
          data = await res.text();
        }

        if (!res.ok) {
          console.error("%c[EMIAS SHIFT FAILED]:%c", "background:#dc2626;color:white;font-weight:bold;padding:2px 4px;", "color:#dc2626;font-weight:bold;", data, payload);
        }

        window.postMessage({
          source: "EMIAS_INTERCEPTOR",
          action: "RES_SHIFT_APPOINTMENT",
          reqId,
          status: res.status,
          data: res.ok ? data : null,
          error: res.ok ? null : (typeof data === "object" ? JSON.stringify(data) : (data || `Ошибка ${res.status}`))
        }, "*");
      } else if (action === "CMD_REFRESH_APPOINTMENTS") {
        if (!window.__EMIAS_PATIENT__) {
          scanStorageForPatient();
        }
        if ((!payload.birthDate || payload.birthDate === "undefined" || payload.birthDate.includes("REDACTED")) && window.__EMIAS_PATIENT__) {
          payload.birthDate = window.__EMIAS_PATIENT__.birthDate;
        }
        if ((!payload.omsNumber || payload.omsNumber === "undefined" || payload.omsNumber.includes("REDACTED")) && window.__EMIAS_PATIENT__) {
          payload.omsNumber = window.__EMIAS_PATIENT__.omsNumber;
        }

        const res = await originalFetch("/api-eip/v10/saOrchestrator/getAppointmentReceptionsByPatient", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        window.postMessage({
          source: "EMIAS_INTERCEPTOR",
          action: "RES_REFRESH_APPOINTMENTS",
          reqId,
          status: res.status,
          data
        }, "*");
      }
    } catch (err) {
      console.error("[EMIAS Interceptor Bridge Error]", err);
      window.postMessage({
        source: "EMIAS_INTERCEPTOR",
        action: action.replace("CMD_", "RES_"),
        reqId,
        error: err.message
      }, "*");
    }
  });
})();
