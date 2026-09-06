// EMIAS Network Interceptor & API Bridge (MAIN execution world)
(() => {
  if (window.__EMIAS_INTERCEPTOR_INITIALIZED__) return;
  window.__EMIAS_INTERCEPTOR_INITIALIZED__ = true;
  window.__EMIAS_CAPTURED_API__ = window.__EMIAS_CAPTURED_API__ || [];

  console.log("%c[EMIAS Assistant]%c Сетевой мост и сниффер активированы", "background:#00897B;color:white;padding:2px 6px;border-radius:3px;font-weight:bold;", "color:#00897B;font-weight:bold;");

  const originalFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

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

  // Handle specialized responses to sync patient & appointments
  function handleSpecializedApi(url, reqBody, resData) {
    if (!resData || !resData.payload) return;

    // Whenever ANY /api-eip/ call has omsNumber and birthDate, capture patientContext!
    if (reqBody && reqBody.omsNumber && reqBody.birthDate) {
      window.postMessage({
        source: "EMIAS_INTERCEPTOR",
        type: "PATIENT_CONTEXT_SYNC",
        payload: {
          omsNumber: String(reqBody.omsNumber),
          birthDate: String(reqBody.birthDate),
          patientId: reqBody.patientId ? String(reqBody.patientId) : null
        }
      }, "*");
    }

    // 1. Captured Active Appointments
    if (url.includes("getAppointmentReceptionsByPatient")) {
      const appointments = resData.payload.appointment || [];
      window.postMessage({
        source: "EMIAS_INTERCEPTOR",
        type: "APPOINTMENTS_SYNC",
        payload: { appointments }
      }, "*");
    }

    // 2. Captured Doctors / Resources Info for appointment
    if (url.includes("getDoctorsInfoForLI") || url.includes("getDoctorsInfo")) {
      const doctorsInfo = resData.payload.doctorsInfo || [];
      const appointmentId = reqBody?.appointmentId || null;

      window.postMessage({
        source: "EMIAS_INTERCEPTOR",
        type: "DOCTORS_INFO_SYNC",
        payload: { appointmentId, doctorsInfo }
      }, "*");
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
        }).catch(err => {
          console.warn("[EMIAS Interceptor] Failed to read response clone:", err);
        });
      } catch (err) {
        console.warn("[EMIAS Interceptor] Clone error:", err);
      }
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
  // Command execution bridge: allows content.js to call EMIAS API
  // -------------------------------------------------------------
  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== "EMIAS_EXTENSION_CONTENT") {
      return;
    }

    const { action, reqId, payload } = event.data;

    try {
      if (action === "CMD_GET_SCHEDULE") {
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
          console.error("%c[EMIAS 400 ERROR]%c", "background:#dc2626;color:white;font-weight:bold;padding:2px 6px;border-radius:3px;", "color:#dc2626;font-weight:bold;", {
            status: res.status,
            errorData: data,
            sentPayload: payload
          });
        }

        window.postMessage({
          source: "EMIAS_INTERCEPTOR",
          action: "RES_GET_SCHEDULE",
          reqId,
          status: res.status,
          data: res.ok ? data : null,
          error: res.ok ? null : (data?.message || data?.error?.message || `Ошибка сервера ${res.status}`)
        }, "*");
      } else if (action === "CMD_GET_DOCTORS_FOR_LI") {
        const res = await originalFetch("/api-eip/v4/saOrchestrator/getDoctorsInfoForLI", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        window.postMessage({
          source: "EMIAS_INTERCEPTOR",
          action: "RES_GET_DOCTORS_FOR_LI",
          reqId,
          status: res.status,
          data
        }, "*");
      } else if (action === "CMD_SHIFT_APPOINTMENT") {
        console.log("%c[EMIAS Assistant]%c Выполняется перенос записи...", "background:#16a34a;color:white;padding:2px 6px;font-weight:bold;", "color:#16a34a;font-weight:bold;", payload);
        const res = await originalFetch("/api-eip/v4/saOrchestrator/shiftAppointment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        window.postMessage({
          source: "EMIAS_INTERCEPTOR",
          action: "RES_SHIFT_APPOINTMENT",
          reqId,
          status: res.status,
          data
        }, "*");
      } else if (action === "CMD_REFRESH_APPOINTMENTS") {
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
