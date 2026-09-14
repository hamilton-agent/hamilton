/* The tools Hamilton can call. Reads run freely; anything that moves money goes through execute_trade,
   which checks the local limits, shows the exact trade and waits for the owner's approval. */
import { parseEther, formatEther, erc20Abi, getAddress } from 'viem';
import { settings, appendJournal, readJournal, appendNote, readNotes } from './config.js';
import { pub, address, ethBalance, fmtEth, explorer } from './wallet.js';
import * as pons from './chain/pons.js';
import { STOCKS, findStock, bestPool, stockPrices } from './chain/stocks.js';

async function ethUsd() {
  try { const j = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { signal: AbortSignal.timeout(6000) }).then(r => r.json()); return j.ethereum.usd; } catch { return null; }
}
const isAddr = a => /^0x[0-9a-fA-F]{40}$/.test(String(a || ''));

export const TOOL_DEFS = [
  { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
  {
    name: 'wallet_status',
    description: 'Hamilton\'s own wallet on Robinhood Chain: address, ETH balance, ETH price in USD, trading limits and how much of today\'s buy limit is used.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'token_balance',
    description: 'Balance of any ERC-20 token (stock token or Pons meme) held by Hamilton\'s wallet.',
    input_schema: { type: 'object', properties: { token: { type: 'string', description: 'Token contract address (0x...) or stock symbol like NVDA' } }, required: ['token'], additionalProperties: false }
  },
  {
    name: 'stock_prices',
    description: 'Live prices of the tokenized stocks on Robinhood Chain (NVDA, SPY, TSLA, AAPL and others), read from their native-ETH Uniswap v4 pools, with pool depth.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'pons_recent_launches',
    description: 'Most recent memecoin launches on Pons, the Robinhood Chain launchpad, with price, market cap, ETH on the curve and graduation progress.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer', description: 'How many launches, 1-30' } }, additionalProperties: false }
  },
  {
    name: 'pons_token',
    description: 'Details of one Pons token: name, symbol, description, curve price, market cap, ETH on the curve, graduation threshold, fees.',
    input_schema: { type: 'object', properties: { token: { type: 'string', description: 'Pons token contract address' } }, required: ['token'], additionalProperties: false }
  },
  {
    name: 'quote_trade',
    description: 'Quote a trade without executing it. venue "pons" trades a Pons token on its bonding curve; venue "uniswap" swaps a stock token against ETH on Uniswap v4. For buys, amount is ETH to spend; for sells, amount is tokens to sell.',
    input_schema: { type: 'object', properties: { venue: { type: 'string', enum: ['pons', 'uniswap'] }, token: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, amount: { type: 'string', description: 'Decimal amount' } }, required: ['venue', 'token', 'side', 'amount'], additionalProperties: false }
  },
  {
    name: 'execute_trade',
    description: 'Execute a trade from Hamilton\'s wallet. The owner sees the exact trade and must approve it; local limits are enforced before asking. Always quote first and give a one-line reason.',
    input_schema: { type: 'object', properties: { venue: { type: 'string', enum: ['pons', 'uniswap'] }, token: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, amount: { type: 'string' }, reason: { type: 'string', description: 'Why this trade, one sentence' } }, required: ['venue', 'token', 'side', 'amount', 'reason'], additionalProperties: false }
  },
  {
    name: 'trade_journal',
    description: 'Hamilton\'s past trades from the local journal: time, venue, token, side, amounts, transaction and the reason given.',
    input_schema: { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false }
  },
  {
    name: 'remember',
    description: 'Save a short note about the owner\'s preferences, strategy or watchlist so it is available in future sessions.',
    input_schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false }
  }
];

function spentToday() {
  const day = new Date().toISOString().slice(0, 10);
  return readJournal(500).filter(e => e.t.startsWith(day) && e.side === 'buy' && e.status === 'filled').reduce((s, e) => s + parseEther(e.spentEth || '0'), 0n);
}

async function uniswap() { return import('./chain/univ4.js'); }

async function resolveToken(venue, token) {
  if (venue === 'uniswap') {
    const s = findStock(token) || (isAddr(token) ? { symbol: 'TOKEN', address: getAddress(token) } : null);
    if (!s) throw Error('Unknown stock token: ' + token + '. Use stock_prices to see the list.');
    return s;
  }
  if (!isAddr(token)) throw Error('Pons trades need the token contract address.');
  return { address: getAddress(token) };
}

export async function runTool(name, input, io) {
  const cfg = settings();
  switch (name) {
    case 'wallet_status': {
      const [bal, usd] = await Promise.all([ethBalance(), ethUsd()]);
      return { address: address(), ethBalance: fmtEth(bal), ethUsd: usd, limits: { maxTradeEth: cfg.maxTradeEth, dailyLimitEth: cfg.dailyLimitEth, spentTodayEth: formatEther(spentToday()), slippagePct: cfg.slippageBps / 100 }, explorer: explorer('address', address()) };
    }
    case 'token_balance': {
      const s = findStock(input.token), token = s ? s.address : input.token;
      if (!isAddr(token)) throw Error('Give a token address or a known stock symbol.');
      const [bal, dec, sym] = await Promise.all([
        pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address()] }),
        pub.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
        pub.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
      ]);
      return { token, symbol: sym, balance: (Number(bal) / 10 ** dec).toString(), raw: bal.toString() };
    }
    case 'stock_prices': return { ethUsd: await ethUsd(), stocks: await stockPrices(await ethUsd()) };
    case 'pons_recent_launches': return { launches: await pons.recentLaunches({ limit: Math.max(1, Math.min(30, input.limit || 12)) }) };
    case 'pons_token': return pons.tokenInfo(getAddress(input.token));
    case 'quote_trade': {
      const t = await resolveToken(input.venue, input.token);
      if (input.venue === 'pons') { const q = await pons.quote({ token: t.address, side: input.side, amount: input.amount }); delete q.raw; return q; }
      const u = await uniswap(); return u.quote({ token: t.address, side: input.side, amount: input.amount });
    }
    case 'execute_trade': {
      const t = await resolveToken(input.venue, input.token);
      if (input.side === 'buy') {
        const wei = parseEther(String(input.amount));
        if (wei > parseEther(cfg.maxTradeEth)) return { declined: true, why: `Above the per-trade limit of ${cfg.maxTradeEth} ETH. The owner can raise it with: hamilton limits --max-trade <eth>` };
        if (spentToday() + wei > parseEther(cfg.dailyLimitEth)) return { declined: true, why: `Would exceed today's buy limit of ${cfg.dailyLimitEth} ETH.` };
        const bal = await ethBalance();
        if (bal < wei + parseEther('0.0002')) return { declined: true, why: `Wallet holds ${fmtEth(bal)} ETH, not enough for this buy plus gas.` };
      }
      const q = input.venue === 'pons' ? await pons.quote({ token: t.address, side: input.side, amount: input.amount }) : await (await uniswap()).quote({ token: t.address, side: input.side, amount: input.amount });
      const label = t.symbol && t.symbol !== 'TOKEN' ? t.symbol : t.address;
      const summary = `${input.side.toUpperCase()} on ${input.venue === 'pons' ? 'Pons curve' : 'Uniswap v4'}\nToken: ${label}\n` +
        (input.side === 'buy' ? `Spend: ${input.amount} ETH\nReceive about: ${q.receiveTokens}` : `Sell: ${input.amount} tokens\nReceive about: ${q.receiveEthApprox || q.receiveEth} ETH`) +
        `\nMax slippage: ${cfg.slippageBps / 100}%\nWhy: ${input.reason}`;
      const ok = await io.approve(summary);
      if (!ok) { appendJournal({ venue: input.venue, token: t.address, symbol: label, side: input.side, amount: input.amount, status: 'declined', reason: input.reason }); return { declined: true, why: 'The owner declined this trade.' }; }
      const r = input.venue === 'pons'
        ? await pons.execute({ token: t.address, side: input.side, amount: input.amount, slippageBps: cfg.slippageBps })
        : await (await uniswap()).execute({ token: t.address, side: input.side, amount: input.amount, slippageBps: cfg.slippageBps });
      appendJournal({ venue: input.venue, token: t.address, symbol: label, side: input.side, amount: input.amount, spentEth: input.side === 'buy' ? input.amount : undefined, status: 'filled', tx: r.hash, reason: input.reason });
      return { ...r, explorer: explorer('tx', r.hash) };
    }
    case 'trade_journal': return { trades: readJournal(Math.max(1, Math.min(200, input.limit || 20))) };
    case 'remember': appendNote(input.note); return { saved: true };
    default: throw Error('Unknown tool ' + name);
  }
}

export const notes = () => readNotes();
export { STOCKS };
