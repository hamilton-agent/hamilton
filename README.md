# Hamilton

**The AI agent with a wallet on Robinhood Chain.**

Hamilton holds its own ETH wallet on Robinhood Chain and trades two things: tokenized stocks (NVDA, SPY, TSLA, AAPL and more) on Uniswap v4, and memecoins on Pons, the Robinhood Chain launchpad. It reads prices, pool depth, curves and the news, proposes a trade with a reason, and waits for you to approve it. Every fill lands in a local journal.

Run it in your terminal, or drive it from your phone through your own Telegram bot.

```bash
npx github:hamilton-agent/hamilton setup     # create Hamilton's wallet
npx github:hamilton-agent/hamilton           # talk to it
```

Requires Node.js 20.19+ and an Anthropic API key (`export ANTHROPIC_API_KEY=...`).

---

## What it does

| | |
|---|---|
| **Wallet** | A fresh key generated on your machine, stored in `~/.hamilton/wallet.json` with 0600 permissions. It never leaves the machine and is never printed. |
| **Stock tokens** | Live prices from the native-ETH Uniswap v4 pools on Robinhood Chain, pool depth, swaps through the Universal Router. |
| **Pons memes** | Recent launches, curve price, market cap, graduation progress; buys and sells straight on the bonding curve. |
| **Research** | Web search for news and context. |
| **Approval** | Nothing moves without you. Each trade is quoted, shown with its reason and slippage, and executed only after you approve it. |
| **Limits** | Per-trade and per-day ETH limits, checked before you are even asked. |
| **Journal** | Every approved, declined and filled trade in `~/.hamilton/journal.jsonl`. |
| **Memory** | Notes about your strategy and watchlist, carried into future sessions. |

## Commands

```bash
hamilton                    # chat (slash commands: /new /balance /status /journal /exit)
hamilton setup              # create the wallet
hamilton balance            # address and ETH balance
hamilton limits             # show limits
hamilton limits --max-trade 0.05 --daily 0.25 --slippage 3
hamilton journal            # past trades
hamilton telegram           # run the Telegram bot
```

Install globally if you prefer: `npm i -g github:hamilton-agent/hamilton`, then `hamilton`.

## Telegram

Create a bot with [@BotFather](https://t.me/BotFather), find your numeric user id, and on an always-on machine run:

```bash
export TELEGRAM_BOT_TOKEN=123456:ABC...
export TELEGRAM_OWNER_ID=123456789
export ANTHROPIC_API_KEY=sk-ant-...
hamilton telegram
```

The bot answers only its owner. `/new`, `/balance`, `/status` and `/help` are handled locally; everything else goes to the agent. Trades arrive as a message with **Approve** and **Decline** buttons.

## How it works

```
you ──► Hamilton (Claude, adaptive thinking)
            │  tools
            ├── wallet_status, token_balance
            ├── stock_prices ─────────► Uniswap v4 StateView on Robinhood Chain
            ├── pons_recent_launches, pons_token ─► Pons V2 factory and curves
            ├── quote_trade ──────────► simulated on chain, no gas
            ├── execute_trade ── limits ─► your approval ─► signed from Hamilton's wallet
            ├── trade_journal, remember
            └── web_search
```

- Model: `claude-opus-5` by default (`hamilton limits --model ... --effort ...`).
- Chain: Robinhood Chain mainnet, chain id 4663, RPC `https://rpc.mainnet.chain.robinhood.com`.
- Pons V2 factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`; Uniswap v4 PoolManager `0x8366a39CC670B4001A1121B8F6A443A643e40951`, Universal Router `0x8876789976dEcBfCbBbe364623C63652db8C0904`.
- State lives in `~/.hamilton` (set `HAMILTON_HOME` to move it).

## Safety

- Fund the wallet with an amount you are prepared to lose. Memecoins go to zero; stock-token pools can be thin.
- Hamilton only trades Pons tokens that trade against ETH and have not graduated.
- The key is yours alone. Back up `~/.hamilton/wallet.json`; if you lose it, the funds are gone.
- This is experimental software, not financial advice.

## $HAMILTON

The project token launches on Pons. Contract on [the site](https://hamilton.run) once live.

Apache-2.0.
