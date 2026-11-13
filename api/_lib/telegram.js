/** Sends one message to the kiosk alerts group. False when it could not be delivered, so the caller retries on its next pass. */
export async function sendTelegram(text, silent = false) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    console.warn('Telegram not configured; message not sent:', text);
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_notification: silent }),
    });
    if (!res.ok) console.error('Telegram refused the message:', res.status);
    return res.ok;
  } catch (err) {
    console.error('Telegram unreachable:', err.message);
    return false;
  }
}
