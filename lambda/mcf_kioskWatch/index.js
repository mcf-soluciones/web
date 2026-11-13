/**
 * Runs every 5 minutes (EventBridge) and asks the website to check the kiosks and send any alerts.
 * It lives on AWS so that alerts keep working when a kiosk is off, and it warns by itself when the website
 * cannot do that check, at most once an hour. No dependencies: Node's own fetch.
 *
 * Environment: KIOSK_WATCH_URL, KIOSK_WATCH_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */
async function warn(text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
  });
}

export const handler = async () => {
  let problem = null;
  try {
    const res = await fetch(process.env.KIOSK_WATCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.KIOSK_WATCH_SECRET}` },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) problem = `respuesta ${res.status}`;
    else console.log(JSON.stringify(await res.json()));
  } catch (err) {
    problem = err.message;
  }
  if (problem) {
    console.error('watch-tick failed:', problem);
    // This rule fires every 5 minutes, so only the first run of each hour warns.
    if (new Date().getUTCMinutes() < 5) await warn(`⚠️ No se puede comprobar el estado de los kioscos (Código 805): ${problem}`);
    throw new Error(problem);
  }
  return { ok: true };
};
