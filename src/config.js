/* Local state lives in ~/.hamilton (override with HAMILTON_HOME): wallet key, settings, sessions, journal, notes. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.HAMILTON_HOME || path.join(os.homedir(), '.hamilton');
export const FILES = {
  wallet: path.join(HOME, 'wallet.json'),
  settings: path.join(HOME, 'settings.json'),
  journal: path.join(HOME, 'journal.jsonl'),
  notes: path.join(HOME, 'notes.md'),
  sessions: path.join(HOME, 'sessions')
};

export const DEFAULTS = {
  model: 'claude-opus-5',
  effort: 'high',
  maxTradeEth: '0.05',   /* largest single trade, in ETH */
  dailyLimitEth: '0.25', /* total ETH spent on buys per UTC day */
  slippageBps: 300
};

export function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(FILES.sessions, { recursive: true, mode: 0o700 });
}

export function settings() {
  ensureHome();
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILES.settings, 'utf8')); } catch {}
  return { ...DEFAULTS, ...saved };
}

export function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  fs.writeFileSync(FILES.settings, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function appendJournal(entry) {
  ensureHome();
  fs.appendFileSync(FILES.journal, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
}

export function readJournal(limit = 50) {
  try {
    return fs.readFileSync(FILES.journal, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(-limit);
  } catch { return []; }
}

export function readNotes() { try { return fs.readFileSync(FILES.notes, 'utf8'); } catch { return ''; } }
export function appendNote(text) { ensureHome(); fs.appendFileSync(FILES.notes, `- ${new Date().toISOString().slice(0, 10)} ${text.replace(/\n/g, ' ')}\n`, { mode: 0o600 }); }

export function loadSession(id) {
  try { return JSON.parse(fs.readFileSync(path.join(FILES.sessions, id + '.json'), 'utf8')); } catch { return null; }
}
export function saveSession(session) {
  ensureHome();
  fs.writeFileSync(path.join(FILES.sessions, session.id + '.json'), JSON.stringify(session), { mode: 0o600 });
}
