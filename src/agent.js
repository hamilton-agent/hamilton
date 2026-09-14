/* The agent loop: Claude with Hamilton's tools, streamed, append-only history, approvals through io.approve. */
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'node:crypto';
import { TOOL_DEFS, runTool, notes } from './tools.js';
import { settings } from './config.js';
import { address } from './wallet.js';

const client = new Anthropic();

const SYSTEM = `You are Hamilton, an AI agent with your own wallet on Robinhood Chain (an Ethereum L2, chain id 4663, gas paid in ETH).
You work for one owner. You research and trade two kinds of assets:
- tokenized stocks such as NVDA, SPY, TSLA and AAPL, which trade against ETH on Uniswap v4 pools on Robinhood Chain;
- memecoins launched on Pons, the Robinhood Chain launchpad, which trade on bonding curves until they graduate.

How you work:
- Read before you act: check the wallet, prices, pool depth and the token's details. Use web search for news and context when it matters.
- Every trade goes through execute_trade. Quote it first, give a one-sentence reason, and never try to route around a declined trade or a limit.
- Size positions to the owner's limits and wallet. Say plainly when liquidity is thin, when a Pons token is close to graduating, or when a stock pool trades away from its usual market.
- Report results with the transaction link. Keep answers short and concrete: numbers, not adjectives.
- You never reveal, export or discuss the wallet's private key.`;

export function newSession() {
  return { id: crypto.randomUUID(), created: new Date().toISOString(), messages: [], usage: { input: 0, output: 0, cacheRead: 0 } };
}

export function statusLine(session) {
  const cfg = settings();
  return `Model ${cfg.model} · effort ${cfg.effort}\nWallet ${address() || 'not set up'}\nLimits: ${cfg.maxTradeEth} ETH per trade, ${cfg.dailyLimitEth} ETH per day, slippage ${cfg.slippageBps / 100}%\nSession ${session.id.slice(0, 8)} · ${session.messages.length} messages · tokens in ${session.usage.input} out ${session.usage.output} cached ${session.usage.cacheRead}`;
}

export async function runTurn(session, userText, io) {
  const cfg = settings();
  const memory = notes();
  session.messages.push({ role: 'user', content: userText });

  for (let step = 0; step < 30; step++) {
    const stream = client.beta.messages.stream({
      model: cfg.model,
      max_tokens: 64000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: cfg.effort },
      system: [
        { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: `Wallet address: ${address() || 'not set up'}\nOwner notes:\n${memory || '(none yet)'}` }
      ],
      tools: TOOL_DEFS,
      messages: session.messages
    });
    stream.on('text', delta => io.text(delta));
    const message = await stream.finalMessage();

    session.messages.push({ role: 'assistant', content: message.content });
    const u = message.usage || {};
    session.usage.input += u.input_tokens || 0;
    session.usage.output += u.output_tokens || 0;
    session.usage.cacheRead += u.cache_read_input_tokens || 0;

    if (message.stop_reason === 'refusal') { io.notice('The model declined this request.'); return; }
    if (message.stop_reason === 'pause_turn') continue;
    if (message.stop_reason !== 'tool_use') { io.text('\n'); return; }

    const calls = message.content.filter(b => b.type === 'tool_use');
    const results = [];
    for (const call of calls) {
      io.tool(call.name, call.input);
      try {
        const out = await runTool(call.name, call.input, io);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: String(e.shortMessage || e.message || e), is_error: true });
      }
    }
    session.messages.push({ role: 'user', content: results });
  }
  io.notice('Stopped after 30 steps. Ask again to continue.');
}
