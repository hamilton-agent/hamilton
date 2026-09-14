/* Hamilton's own wallet on Robinhood Chain. The private key is generated locally and stored in
   ~/.hamilton/wallet.json with 0600 permissions. It never leaves this machine and is never printed. */
import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, fallback, formatEther } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { FILES, ensureHome } from './config.js';

export const CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com'] } },
  blockExplorers: { default: { name: 'Robinscan', url: 'https://robinscan.io' } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } }
};
export const pub = createPublicClient({ chain: CHAIN, transport: fallback(CHAIN.rpcUrls.default.http.map(u => http(u, { timeout: 20000 }))) });
export const explorer = (kind, v) => `${CHAIN.blockExplorers.default.url}/${kind}/${v}`;

export function hasWallet() { return fs.existsSync(FILES.wallet); }

export function createWallet() {
  ensureHome();
  if (hasWallet()) throw Error('A wallet already exists at ' + FILES.wallet);
  const key = generatePrivateKey(), account = privateKeyToAccount(key);
  fs.writeFileSync(FILES.wallet, JSON.stringify({ address: account.address, privateKey: key, created: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return account.address;
}

let cached = null;
export function wallet() {
  if (cached) return cached;
  if (!hasWallet()) throw Error('No wallet yet. Run: hamilton setup');
  const { privateKey } = JSON.parse(fs.readFileSync(FILES.wallet, 'utf8'));
  const account = privateKeyToAccount(privateKey);
  cached = { account, address: account.address, client: createWalletClient({ account, chain: CHAIN, transport: http(CHAIN.rpcUrls.default.http[0], { timeout: 30000 }) }) };
  return cached;
}

export const address = () => (hasWallet() ? wallet().address : null);
export async function ethBalance(addr = address()) { return addr ? pub.getBalance({ address: addr }) : 0n; }
export const fmtEth = (wei, dp = 6) => { const s = formatEther(BigInt(wei)); const [i, f = ''] = s.split('.'); return f ? `${i}.${f.slice(0, dp).replace(/0+$/, '') || '0'}` : i; };

/* simulate first, then send, then wait for the receipt */
export async function writeContract(req) {
  const w = wallet();
  const { request } = await pub.simulateContract({ account: w.account, ...req });
  const hash = await w.client.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120000 });
  if (receipt.status !== 'success') throw Error('Transaction reverted: ' + explorer('tx', hash));
  return { hash, receipt };
}
export async function sendRaw({ to, data, value = 0n }) {
  const w = wallet();
  await pub.call({ account: w.address, to, data, value });
  const hash = await w.client.sendTransaction({ to, data, value });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120000 });
  if (receipt.status !== 'success') throw Error('Transaction reverted: ' + explorer('tx', hash));
  return { hash, receipt };
}
