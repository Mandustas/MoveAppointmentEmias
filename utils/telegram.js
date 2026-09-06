// Telegram Bot API Helper Module

const TelegramBot = {
  /**
   * Send a message to Telegram
   */
  async sendMessage(botToken, chatId, text, options = {}) {
    if (!botToken || !chatId) return null;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const body = {
      chat_id: chatId,
      text: text,
      parse_mode: options.parseMode || "Markdown"
    };

    if (options.replyMarkup) {
      body.reply_markup = options.replyMarkup;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return await res.json();
  },

  /**
   * Edit existing message
   */
  async editMessageText(botToken, chatId, messageId, text, options = {}) {
    if (!botToken || !chatId || !messageId) return null;
    const url = `https://api.telegram.org/bot${botToken}/editMessageText`;
    const body = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      parse_mode: options.parseMode || "Markdown"
    };

    if (options.replyMarkup) {
      body.reply_markup = options.replyMarkup;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return await res.json();
  },

  /**
   * Answer callback query (inline button click)
   */
  async answerCallbackQuery(botToken, callbackQueryId, text = "") {
    if (!botToken || !callbackQueryId) return null;
    const url = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text: text
      })
    });
    return await res.json();
  },

  /**
   * Long polling getUpdates
   */
  async getUpdates(botToken, offset = 0, timeout = 10) {
    if (!botToken) return [];
    const url = `https://api.telegram.org/bot${botToken}/getUpdates?offset=${offset}&timeout=${timeout}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      return data.ok ? data.result : [];
    } catch (e) {
      return [];
    }
  }
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = TelegramBot;
}
