# agate for judges: try it in three minutes

agate makes the price of compute tradable: an open onchain price for renting a GPU for an hour, and monthly markets
on it that anyone (a person, an app or an AI agent) can trade to lock that price in. Everything runs on Monad testnet
with free test dollars.

**Open:** https://agate.elpabl0.xyz (phone or desktop)

## 1. Sign in (30 seconds)

- Tap **Sign in** and use your email (a code arrives) or Google. No wallet, no extension, no gas: your account is
  created for you and network fees are on agate.
- The first sign-in adds **10,000 test dollars** (about 6 seconds). You can take 10,000 more each day.
- No inbox to hand? The portal's access instructions give a test login that works without one.

## 2. Trade (2 minutes)

On **Markets**, pick **H100**, month **November 2026**. You see today's price, the market price, the month's range
(a floor of $1.95 and a ceiling of $8.00 an hour) and Kuru's order book (switch to **Pro** for the full book).

1. **Long:** enter $100 and confirm. You now hold November's H100 price: you get back November's average price for
   each GPU-hour you bought. The confirmation links to the transaction on Monad.
2. **Short, paid daily:** pick Short, tick **Pay me daily**, enter a size and confirm. You've locked in what you earn
   per GPU-hour; each day of November pays its share as soon as that day's price is final.
3. **Positions:** both trades are there. **Close** either one at the market price.

Every trade is fully backed when it's made, so there are no margin calls and no liquidations.

## 3. Check the price (30 seconds)

Open **Index**. Each GPU's price is the middle of what the clouds charge on their own public price pages, read every
hour; every cloud's price is shown beside it. How it's made: [docs/method.md](docs/method.md).

## 4. Connect an AI (optional, 2 minutes)

Open **AI**. It shows agate's link for AI apps and, for Claude Code, the command to run:

```sh
claude mcp add --transport http agate https://agate-1.tailf06dd7.ts.net/mcp
```

Your AI app then opens agate to ask for your OK: set a budget and limits (per trade, trades a day, end date) and
allow it. (Or use **Connect from here instead** to get a link for any other MCP app.) Then ask it "what's the H100 price on agate?" or "open a $50 H100 November long". Its trades come from its own pocket,
within your limits, and show on the AI page. Steps for Codex, Hermes, OpenClaw and others: [agents/AGENTS.md](agents/AGENTS.md).

## Proof onchain (Monad testnet, chain 10143)

| What | Address |
|---|---|
| The price (index contract) | [`0x4193...Da36`](https://testnet.monadexplorer.com/address/0x419394b0Edf3d03164a7C06ea525cC1ED0e5Da36) |
| H100 November 2026 market | [`0xbc28...c577`](https://testnet.monadexplorer.com/address/0xbc28e45ede13d0bd61d78f6f3d9f6341b78fc577) |
| Its Kuru order book | [`0xf245...3a9c`](https://testnet.monadexplorer.com/address/0xf2455ab8bbb5f8fa82d2a626a56bd5df7ef43a9c) |
| Market factory | [`0xEdBE...a0b5`](https://testnet.monadexplorer.com/address/0xEdBE3e696944443bBCe7eb3CD04E626e9396a0b5) |
| Test dollar | [`0x3A05...bF38`](https://testnet.monadexplorer.com/address/0x3A0513b2A19EE92eb3f73Dd06EefEe4D477CbF38) |

All addresses: [`contracts/deployments/10143.json`](contracts/deployments/10143.json). The same data as JSON, no key:
https://agate.elpabl0.xyz/api/v1/prices ([docs/api.md](docs/api.md)).

## Good to know

- The price is written onchain by a Chainlink CRE workflow (run in CRE's simulator, `cre workflow simulate
  --broadcast`) and must be countersigned by a second, independent reader before a changed price counts.
- Our own market maker keeps buy and sell orders on Kuru so there is always a price to trade at.
- Test dollars and tokens have no monetary value.
