#!/usr/bin/env node
/* hamilton            chat with the agent
   hamilton setup      create the wallet
   hamilton balance    address and ETH balance
   hamilton limits     show or change trading limits
   hamilton journal    past trades
   hamilton telegram   run the owner-locked Telegram bot */
import readline from 'node:readline';
import { settings, saveSettings, readJournal, loadSession, saveSession, HOME } from './config.js';
import { hasWallet, createWallet, address, ethBalance, fmtEth, explorer } from './wallet.js';

const C = { dim: s => `\x1b[2m${s}\x1b[0m`, gold: s => `\x1b[33m${s}\x1b[0m`, green: s => `\x1b[32m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m` };
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null; };

const banner = () => console.log(`${C.gold(C.bold('Hamilton'))} ${C.dim('· the AI agent with a wallet on Robinhood Chain')}`);

async function main() {
  if (cmd === 'setup') {
    banner();
    if (hasWallet()) { console.log('Wallet already exists: ' + address()); return; }
    const a = createWallet();
    console.log(`\nWallet created: ${C.green(a)}\nKey stored at ${HOME}/wallet.json (0600). Back it up; it is never shown again.\n\nFund it with a little ETH on Robinhood Chain, then run ${C.bold('hamilton')}.`);
    return;
  }
  if (cmd === 'balance') { console.log(`${address()}\n${fmtEth(await ethBalance())} ETH\n${explorer('address', address())}`); return; }
  if (cmd === 'limits') {
    const patch = {};
    if (flag('--max-trade')) patch.maxTradeEth = flag('--max-trade');
    if (flag('--daily')) patch.dailyLimitEth = flag('--daily');
    if (flag('--slippage')) patch.slippageBps = Math.round(parseFloat(flag('--slippage')) * 100);
    if (flag('--model')) patch.model = flag('--model');
    if (flag('--effort')) patch.effort = flag('--effort');
    const s = Object.keys(patch).length ? saveSettings(patch) : settings();
    console.log(`max trade ${s.maxTradeEth} ETH · daily ${s.dailyLimitEth} ETH · slippage ${s.slippageBps / 100}% · model ${s.model} · effort ${s.effort}`);
    return;
  }
  if (cmd === 'journal') {
    const rows = readJournal(50);
    if (!rows.length) { console.log('No trades yet.'); return; }
    for (const r of rows) console.log(`${r.t.slice(0, 16)}  ${r.status === 'filled' ? C.green(r.side) : C.dim(r.side + ' ' + r.status)}  ${r.symbol}  ${r.amount}  ${r.tx ? explorer('tx', r.tx) : ''}\n  ${C.dim(r.reason || '')}`);
    return;
  }
  if (cmd === 'telegram') { const { startTelegram } = await import('./telegram.js'); await startTelegram(); return; }
  if (cmd && !['chat'].includes(cmd)) { console.log('Commands: setup, balance, limits, journal, telegram, or no command to chat.'); return; }

  banner();
  if (!hasWallet()) { console.log(`\nNo wallet yet. Run ${C.bold('hamilton setup')} first.`); return; }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) console.log(C.dim('Set ANTHROPIC_API_KEY (or log in with `ant auth login`) so Hamilton can think.'));
  const { runTurn, newSession, statusLine } = await import('./agent.js');
  let session = loadSession('cli') || { ...newSession(), id: 'cli' };
  console.log(C.dim(`${address()} · ${fmtEth(await ethBalance())} ETH · /help for commands\n`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: C.gold('hamilton › ') });
  const ask = q => new Promise(res => rl.question(q, a => res(a)));
  const io = {
    text: d => process.stdout.write(d),
    tool: (name) => process.stdout.write(C.dim(`\n  · ${name}\n`)),
    notice: t => console.log(C.dim('\n' + t)),
    approve: async summary => {
      console.log('\n' + C.bold('Approve this trade?') + '\n' + summary.split('\n').map(l => '  ' + l).join('\n'));
      const a = (await ask(C.gold('  approve? [y/N] '))).trim().toLowerCase();
      return a === 'y' || a === 'yes';
    }
  };
  rl.prompt();
  rl.on('line', async line => {
    const text = line.trim();
    if (!text) return rl.prompt();
    if (text === '/exit' || text === '/quit') { rl.close(); return; }
    if (text === '/help') { console.log('/new fresh session · /balance · /status · /journal · /exit'); return rl.prompt(); }
    if (text === '/new') { session = { ...newSession(), id: 'cli' }; saveSession(session); console.log('New session.'); return rl.prompt(); }
    if (text === '/balance') { console.log(`${fmtEth(await ethBalance())} ETH`); return rl.prompt(); }
    if (text === '/status') { console.log(statusLine(session)); return rl.prompt(); }
    if (text === '/journal') { console.log(readJournal(10).map(r => `${r.t.slice(0, 16)} ${r.side} ${r.symbol} ${r.amount} ${r.status}`).join('\n') || 'No trades yet.'); return rl.prompt(); }
    rl.pause();
    try { await runTurn(session, text, io); }
    catch (e) { console.log(C.red('\n' + (e.message || e))); }
    finally { saveSession(session); rl.resume(); console.log(); rl.prompt(); }
  });
  rl.on('close', () => process.exit(0));
}

main().catch(e => { console.error(C.red(e.message || e)); process.exit(1); });
