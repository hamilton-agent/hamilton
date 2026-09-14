/* Remote control through Telegram. Run `hamilton telegram` on an always-on machine with TELEGRAM_BOT_TOKEN
   (from @BotFather) and TELEGRAM_OWNER_ID (your numeric user id). Only the owner is answered. Trades are
   approved with inline buttons. Uses the plain Bot API over fetch, long polling, no extra dependencies. */
import { runTurn, newSession, statusLine } from './agent.js';
import { address, ethBalance, fmtEth } from './wallet.js';
import { loadSession, saveSession } from './config.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const OWNER = String(process.env.TELEGRAM_OWNER_ID || '');
const API = m => `https://api.telegram.org/bot${TOKEN}/${m}`;
async function tg(method, body) {
  const r = await fetch(API(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.ok) throw Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}
const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text: text.slice(0, 4000), disable_web_page_preview: true, ...extra });

export async function startTelegram() {
  if (!TOKEN || !/^\d+$/.test(OWNER)) throw Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID first.');
  const me = await tg('getMe', {});
  console.log(`Hamilton is listening as @${me.username}. Only user ${OWNER} is answered.`);
  const sessionId = 'telegram-' + OWNER;
  let session = loadSession(sessionId) || { ...newSession(), id: sessionId };
  const pending = new Map(); /* approval id -> resolve */
  let offset = 0, busy = false;

  for (;;) {
    let updates = [];
    try { updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }); }
    catch (e) { console.error(e.message); await new Promise(r => setTimeout(r, 5000)); continue; }
    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.callback_query) {
        const q = u.callback_query;
        if (String(q.from.id) !== OWNER) { await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Not yours.' }).catch(() => {}); continue; }
        const [verdict, id] = String(q.data || '').split(':');
        const resolve = pending.get(id);
        if (resolve) { pending.delete(id); resolve(verdict === 'yes'); }
        await tg('answerCallbackQuery', { callback_query_id: q.id, text: verdict === 'yes' ? 'Approved' : 'Declined' }).catch(() => {});
        await tg('editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
        continue;
      }
      const m = u.message;
      if (!m || !m.text) continue;
      if (String(m.from.id) !== OWNER) { await send(m.chat.id, 'This Hamilton answers only its owner.').catch(() => {}); continue; }
      const chat = m.chat.id, text = m.text.trim();
      if (text === '/start' || text === '/help') { await send(chat, 'Hamilton, the AI agent with a wallet on Robinhood Chain.\n\n/new start a fresh session\n/balance wallet balance\n/status model, limits, session\n\nAnything else goes to the agent. Every trade asks for your approval here.'); continue; }
      if (text === '/new') { session = { ...newSession(), id: sessionId }; saveSession(session); await send(chat, 'New session.'); continue; }
      if (text === '/balance') { await send(chat, `${address()}\n${fmtEth(await ethBalance(), 6)} ETH on Robinhood Chain`); continue; }
      if (text === '/status') { await send(chat, statusLine(session)); continue; }
      if (busy) { await send(chat, 'Still working on the last message.'); continue; }
      busy = true;
      (async () => {
        let buffer = '';
        const flush = async (force) => {
          const cut = force ? buffer.length : buffer.lastIndexOf('\n\n');
          if (cut <= 0) return;
          const part = buffer.slice(0, cut).trim(); buffer = buffer.slice(cut);
          if (part) await send(chat, part).catch(() => {});
        };
        const io = {
          text: d => { buffer += d; if (buffer.length > 1500) flush(false); },
          tool: (name) => { tg('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {}); },
          notice: t => send(chat, t).catch(() => {}),
          approve: async summary => {
            await flush(true);
            const id = Math.random().toString(36).slice(2, 10);
            await send(chat, 'Approve this trade?\n\n' + summary, { reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: 'yes:' + id }, { text: 'Decline', callback_data: 'no:' + id }]] } });
            return new Promise(resolve => { pending.set(id, resolve); setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(false); } }, 10 * 60 * 1000); });
          }
        };
        try { await runTurn(session, text, io); await flush(true); }
        catch (e) { await flush(true); await send(chat, 'Error: ' + e.message).catch(() => {}); }
        finally { saveSession(session); busy = false; }
      })();
    }
  }
}
