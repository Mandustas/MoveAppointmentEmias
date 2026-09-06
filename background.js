// Background Service Worker (Manifest V3)

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[EMIAS Assistant] Расширение успешно установлено.");
  await chrome.action.setBadgeText({ text: "" });
});

// Update badge or send notifications
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 1. Send test message to Telegram
  if (message.type === "SEND_TELEGRAM_TEST") {
    (async () => {
      try {
        const { botToken, chatId } = message.payload;
        if (!botToken || !chatId) {
          sendResponse({ success: false, error: "Укажите Bot Token и Chat ID" });
          return;
        }

        const text = encodeURIComponent("🔔 *ЕМИАС Автоперенос*\nТестовое уведомление успешно доставлено!");
        const url = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${text}&parse_mode=Markdown`;

        const res = await fetch(url);
        const data = await res.json();

        if (data.ok) {
          sendResponse({ success: true });
        } else {
          sendResponse({ success: false, error: data.description || "Ошибка Telegram API" });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open
  }

  // 2. Send actual success notification to Telegram
  if (message.type === "SEND_TELEGRAM_NOTIFICATION") {
    (async () => {
      try {
        const store = await chrome.storage.local.get(["tgToken", "tgChatId"]);
        const { tgToken, tgChatId } = store;
        if (!tgToken || !tgChatId) {
          console.log("[EMIAS Assistant] Telegram не настроен, уведомление пропущено");
          sendResponse({ success: false, reason: "Telegram not configured" });
          return;
        }

        const text = encodeURIComponent(message.payload.text || "🎉 Запись в ЕМИАС успешно перенесена!");
        const url = `https://api.telegram.org/bot${tgToken}/sendMessage?chat_id=${tgChatId}&text=${text}&parse_mode=Markdown`;

        const res = await fetch(url);
        const data = await res.json();
        sendResponse({ success: Boolean(data.ok) });
      } catch (err) {
        console.error("[EMIAS Assistant] Telegram send error:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // 3. Update extension icon badge
  if (message.type === "UPDATE_MONITOR_BADGE") {
    const text = message.active ? "ON" : "";
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: message.active ? "#16a34a" : "#64748b" });
    sendResponse({ status: "ok" });
    return false;
  }

  return false;
});
