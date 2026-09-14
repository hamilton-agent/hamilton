/* Uniswap v4 swaps between native ETH and stock tokens on Robinhood Chain, through the Universal Router.
   Encoding verified with eth_simulateV1 against chain 4663: quotes matched simulated fills to the wei.
   The deployed router's SWAP_EXACT_IN_SINGLE struct carries an extra minHopPriceX36 field before hookData;
   the older 5-field struct still executes but silently misreads fields, so keep this layout. */
import { encodeAbiParameters, encodeFunctionData, encodePacked, formatEther, parseEther, getAddress, zeroAddress, maxUint256 } from 'viem';
import { pub, wallet, sendRaw } from '../wallet.js';
import { bestPool } from './stocks.js';

export const ADDR = {
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  router: '0x8876789976dEcBfCbBbe364623C63652db8C0904',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3'
};
const ACTIONS = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f };
const V4_SWAP = 0x10;
const POOL_KEY = { type: 'tuple', name: 'poolKey', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] };
const QUOTER_ABI = [{ type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable', inputs: [{ type: 'tuple', name: 'params', components: [POOL_KEY, { name: 'zeroForOne', type: 'bool' }, { name: 'exactAmount', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }], outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }] }];
const ROUTER_ABI = [{ type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }], outputs: [] }];
const PERMIT2_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'token', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }], outputs: [] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }], outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] }
];
const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }
];

async function route(token, side, amount) {
  const pool = await bestPool(token);
  if (!pool) throw Error('No live ETH pool for this token on Uniswap v4.');
  const key = { currency0: zeroAddress, currency1: getAddress(token), fee: pool.tier.fee, tickSpacing: pool.tier.tickSpacing, hooks: zeroAddress };
  const zeroForOne = side === 'buy'; /* ETH is always currency0 */
  const amountIn = parseEther(String(amount)); /* stock tokens use 18 decimals, like ETH */
  const { result } = await pub.simulateContract({ address: ADDR.quoter, abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: '0x' }] });
  return { pool, key, zeroForOne, amountIn, amountOut: result[0] };
}

export async function quote({ token, side, amount }) {
  const r = await route(token, side, amount);
  const feePct = r.pool.tier.fee / 10000;
  return side === 'buy'
    ? { venue: 'uniswap v4', pool: `${feePct}% ETH pool`, spendEth: String(amount), receiveTokens: formatEther(r.amountOut), poolDepthEth: +r.pool.depthEth.toFixed(3) }
    : { venue: 'uniswap v4', pool: `${feePct}% ETH pool`, sellTokens: String(amount), receiveEth: formatEther(r.amountOut), poolDepthEth: +r.pool.depthEth.toFixed(3) };
}

export function swapCalldata({ key, zeroForOne, amountIn, minOut, deadline }) {
  const swap = encodeAbiParameters([{ type: 'tuple', components: [POOL_KEY, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }],
    [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: '0x' }]);
  const cin = zeroForOne ? key.currency0 : key.currency1, cout = zeroForOne ? key.currency1 : key.currency0;
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cin, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [cout, minOut]);
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [ACTIONS.SWAP_EXACT_IN_SINGLE, ACTIONS.SETTLE_ALL, ACTIONS.TAKE_ALL]);
  const input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swap, settle, take]]);
  return { to: ADDR.router, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: 'execute', args: [encodePacked(['uint8'], [V4_SWAP]), [input], BigInt(deadline)] }), value: zeroForOne ? amountIn : 0n };
}

export async function execute({ token, side, amount, slippageBps }) {
  const me = wallet().address, r = await route(token, side, amount);
  const minOut = r.amountOut * BigInt(10000 - slippageBps) / 10000n;
  if (side === 'sell') {
    const erc = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [me, ADDR.permit2] });
    if (erc < r.amountIn) await sendRaw({ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ADDR.permit2, maxUint256] }) });
    const [amt, exp] = await pub.readContract({ address: ADDR.permit2, abi: PERMIT2_ABI, functionName: 'allowance', args: [me, token, ADDR.router] });
    if (amt < r.amountIn || Number(exp) <= Date.now() / 1000 + 120) {
      await sendRaw({ to: ADDR.permit2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [token, ADDR.router, (1n << 160n) - 1n, Math.floor(Date.now() / 1000) + 3600] }) });
    }
  }
  const tx = swapCalldata({ key: r.key, zeroForOne: r.zeroForOne, amountIn: r.amountIn, minOut, deadline: Math.floor(Date.now() / 1000) + 600 });
  const { hash } = await sendRaw(tx);
  return side === 'buy'
    ? { hash, spentEth: String(amount), expectedTokens: formatEther(r.amountOut), minTokens: formatEther(minOut) }
    : { hash, soldTokens: String(amount), expectedEth: formatEther(r.amountOut), minEth: formatEther(minOut) };
}
