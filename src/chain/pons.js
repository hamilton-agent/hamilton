/* Pons V2 (the Robinhood Chain launchpad): recent launches, curve state, quotes by simulation, buy and sell. */
import { formatEther, parseEther, erc20Abi, maxUint256 } from 'viem';
import * as P from './pons-abi.js';
import { pub, wallet, writeContract, explorer } from '../wallet.js';

/* the Robinhood RPC returns at most 10,000 logs per query: halve the window on overflow */
export async function logsWindowed({ address, event, fromBlock, toBlock, args }) {
  const out = [];
  let from = fromBlock, span = 20000n;
  while (from <= toBlock) {
    const to = from + span - 1n > toBlock ? toBlock : from + span - 1n;
    try { out.push(...(await pub.getLogs({ address, event, fromBlock: from, toBlock: to, args }))); from = to + 1n; if (span < 20000n) span *= 2n; }
    catch (e) { if (span > 1n && /exceeds limit|too many|range/i.test(String(e.details || '') + (e.shortMessage || '') + (e.message || ''))) { span /= 2n; continue; } throw e; }
  }
  return out;
}

export async function curveState(curve) {
  const f = n => pub.readContract({ address: curve, abi: P.CURVE_ABI, functionName: n });
  const [[quoteReserve, tokenReserve], feeBps, creatorTaxBps, sellable, graduated, ready, realQuote, threshold] = await Promise.all([
    f('getReserves'), f('feeBps'), f('creatorTaxBps'), f('sellableTokens'), f('graduated'), f('readyToGraduate'), f('realQuoteReserve'), f('graduationThreshold')
  ]);
  return { quoteReserve, tokenReserve, feeBps, creatorTaxBps, sellable, graduated: graduated || ready, realQuote, threshold, price: P.priceOf({ quoteReserve, tokenReserve }) };
}

export async function launched(token) {
  const L = await pub.readContract({ address: P.FACTORY, abi: P.FACTORY_ABI, functionName: 'getLaunchedToken', args: [token] });
  if (!L.exists) throw Error('Not a Pons V2 token: ' + token);
  return L;
}

const NATIVE = '0x0000000000000000000000000000000000000000';
async function quoteAsset(pairToken) {
  if (pairToken === NATIVE) return { symbol: 'ETH', decimals: 18, native: true };
  const [symbol, decimals] = await Promise.all([
    pub.readContract({ address: pairToken, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
    pub.readContract({ address: pairToken, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18)
  ]);
  return { symbol, decimals: Number(decimals), native: false, address: pairToken };
}
const fmtUnits = (v, d) => { const s = (BigInt(v) * 10n ** 18n / 10n ** BigInt(d)); return formatEther(s); };

export async function tokenInfo(token) {
  const L = await launched(token);
  const [name, symbol, description, c, q] = await Promise.all([
    pub.readContract({ address: token, abi: P.TOKEN_ABI, functionName: 'name' }),
    pub.readContract({ address: token, abi: P.TOKEN_ABI, functionName: 'symbol' }),
    pub.readContract({ address: token, abi: P.TOKEN_ABI, functionName: 'description' }).catch(() => ''),
    curveState(L.curve),
    quoteAsset(L.pairToken)
  ]);
  /* reserves are in the quote asset's own decimals; price() scales quote/token by 1e18 */
  return {
    token, curve: L.curve, name, symbol, description: String(description).slice(0, 280),
    tradesAgainst: q.symbol, tradableByHamilton: q.native && !c.graduated,
    pricePerToken: fmtUnits(c.price, q.decimals) + ' ' + q.symbol, marketCap: fmtUnits(c.price * 1000000000n, q.decimals) + ' ' + q.symbol,
    onCurve: fmtUnits(c.realQuote, q.decimals) + ' ' + q.symbol, graduatesAt: fmtUnits(c.threshold, q.decimals) + ' ' + q.symbol, graduated: c.graduated,
    feePct: Number(c.feeBps) / 100, creatorTaxPct: Number(c.creatorTaxBps) / 100,
    pons: 'https://www.ponsfamily.com/launchpad/' + token, explorer: explorer('token', token)
  };
}

async function ethCurve(token) {
  const L = await launched(token);
  if (L.pairToken !== NATIVE) { const q = await quoteAsset(L.pairToken); throw Error(`This Pons token trades against ${q.symbol}, not ETH. Hamilton only trades ETH curves.`); }
  return L;
}

export async function recentLaunches({ blocks = 20000, limit = 15 } = {}) {
  const head = await pub.getBlockNumber();
  const ev = P.FACTORY_ABI.find(x => x.name === 'TokenLaunched');
  const logs = await logsWindowed({ address: P.FACTORY, event: ev, fromBlock: head - BigInt(blocks), toBlock: head });
  const picked = logs.slice(-limit).reverse();
  const rows = await Promise.all(picked.map(l => tokenInfo(l.args.token).then(x => ({ ...x, block: Number(l.blockNumber), deployer: l.args.deployer })).catch(() => null)));
  return rows.filter(Boolean);
}

export async function quote({ token, side, amount }) {
  const L = await ethCurve(token), me = wallet().address;
  if (side === 'buy') {
    const wei = parseEther(String(amount));
    const sim = await pub.simulateContract({ account: me, address: L.curve, abi: P.CURVE_ABI, functionName: 'buy', args: [wei, 0n, me], value: wei, stateOverride: [{ address: me, balance: wei * 2n + parseEther('0.01') }] });
    return { curve: L.curve, spendEth: String(amount), receiveTokens: formatEther(sim.result), raw: { in: wei, out: sim.result } };
  }
  const tokens = parseEther(String(amount));
  const c = await curveState(L.curve), q = P.quoteSell(c, tokens);
  return { curve: L.curve, sellTokens: String(amount), receiveEthApprox: formatEther(q.out), raw: { in: tokens, out: q.out } };
}

export async function execute({ token, side, amount, slippageBps }) {
  const L = await ethCurve(token), me = wallet().address, keep = 10000n - BigInt(slippageBps);
  if (side === 'buy') {
    const wei = parseEther(String(amount));
    const sim = await pub.simulateContract({ account: me, address: L.curve, abi: P.CURVE_ABI, functionName: 'buy', args: [wei, 0n, me], value: wei });
    const { hash } = await writeContract({ address: L.curve, abi: P.CURVE_ABI, functionName: 'buy', args: [wei, sim.result * keep / 10000n, me], value: wei });
    return { hash, spentEth: formatEther(wei), expectedTokens: formatEther(sim.result) };
  }
  const tokens = parseEther(String(amount));
  const allowance = await pub.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [me, L.curve] });
  if (allowance < tokens) await writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [L.curve, maxUint256] });
  const sim = await pub.simulateContract({ account: me, address: L.curve, abi: P.CURVE_ABI, functionName: 'sell', args: [tokens, 0n, me] });
  const { hash } = await writeContract({ address: L.curve, abi: P.CURVE_ABI, functionName: 'sell', args: [tokens, sim.result * keep / 10000n, me] });
  return { hash, soldTokens: formatEther(tokens), expectedEth: formatEther(sim.result) };
}
