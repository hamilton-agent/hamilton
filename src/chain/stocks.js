/* Tokenized stocks on Robinhood Chain, priced from their native-ETH Uniswap v4 pools. */
import { readFileSync } from 'node:fs';
import { encodeAbiParameters, keccak256, formatEther, getAddress } from 'viem';
import { pub } from '../wallet.js';

export const STOCKS = JSON.parse(readFileSync(new URL('../data/stocks.json', import.meta.url), 'utf8'));
export const V4 = { stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b' };
export const TIERS = [{ fee: 10000, tickSpacing: 200 }, { fee: 3000, tickSpacing: 60 }];
const NATIVE = '0x0000000000000000000000000000000000000000';
const Q96 = 1n << 96n;
const SV_ABI = [
  { type: 'function', name: 'getSlot0', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'protocolFee', type: 'uint24' }, { name: 'lpFee', type: 'uint24' }] },
  { type: 'function', name: 'getLiquidity', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'uint128' }] }
];

export const poolKey = (token, tier) => ({ currency0: NATIVE, currency1: getAddress(token), fee: tier.fee, tickSpacing: tier.tickSpacing, hooks: NATIVE });
export const poolId = key => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
  [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]
));

export function findStock(query) {
  const q = String(query || '').trim().toLowerCase();
  return STOCKS.find(s => s.symbol.toLowerCase() === q || s.address.toLowerCase() === q || s.name.toLowerCase() === q) || null;
}

/* the deepest live ETH pool for a token: price in ETH per whole token and an approximate ETH depth */
export async function bestPool(token) {
  const res = await pub.multicall({ contracts: TIERS.flatMap(t => { const id = poolId(poolKey(token, t)); return [{ address: V4.stateView, abi: SV_ABI, functionName: 'getSlot0', args: [id] }, { address: V4.stateView, abi: SV_ABI, functionName: 'getLiquidity', args: [id] }]; }), allowFailure: true });
  let best = null;
  TIERS.forEach((tier, i) => {
    const slot = res[i * 2].result, L = res[i * 2 + 1].result || 0n;
    if (!slot || slot[0] === 0n || L === 0n) return;
    const sqrtP = slot[0];
    const ethPerToken = Number(Q96 * Q96 * 10n ** 18n / (sqrtP * sqrtP)) / 1e18;
    const depthEth = Number(formatEther(2n * L * Q96 / sqrtP));
    if (!best || depthEth > best.depthEth) best = { tier, sqrtPriceX96: sqrtP, liquidity: L, ethPerToken, depthEth };
  });
  return best;
}

export async function stockPrices(ethUsd) {
  const rows = await Promise.all(STOCKS.map(async s => {
    const p = await bestPool(s.address).catch(() => null);
    return { symbol: s.symbol, name: s.name, address: s.address, pool: p ? `${p.tier.fee / 10000}%` : 'no live ETH pool', ethPerToken: p ? +p.ethPerToken.toPrecision(6) : null, usd: p && ethUsd ? +(p.ethPerToken * ethUsd).toFixed(2) : null, depthEth: p ? +p.depthEth.toFixed(3) : 0 };
  }));
  return rows;
}
