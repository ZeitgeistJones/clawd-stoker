# clawd stoker

Keeper bot for the CLAWD Incinerator on Base. Races to call `incinerate()` the moment each 8h cooldown expires.

**How it wins:** the current champion lands 2s after every window opens — meaning it's in the first eligible block. Base seals a block every 2s on a fixed grid, so the race is won by (1) being in the sequencer's pool before that specific block is built, and (2) paying a higher priority fee so you're ordered ahead of anyone else in it. Stoker pre-signs the transaction, calibrates its clock against a live block seal (±150ms accuracy), computes the exact eligible block on the grid, and broadcasts 900ms before it's sealed.

**Economics, honestly:** the caller reward is 10,000 CLAWD ≈ $0.07/win at current prices. ~3 windows/day ≈ $0.21/day. Hosting is ~$5/mo. This is for sport, not profit.

## Setup

### 1. Make a dedicated wallet
Create a **brand new wallet** in MetaMask/Rabby — never use your main one, since its private key lives on the host as an env var. Send it ~0.002 ETH **on Base** (enough for 1,000+ attempts at these gas levels).

### 2. Get an RPC URL (optional but recommended)
The free public RPC works, but a free Alchemy or QuickNode endpoint (Base mainnet) has lower latency, which is the whole game. Sign up, create a Base app, copy the HTTPS URL.

### 3. Deploy on Railway (no CLI needed)
1. Push this folder to a GitHub repo (GitHub Desktop: create repo → drop these files in → commit → push)
2. Go to railway.app → New Project → **Deploy from GitHub repo** → pick the repo
3. In the service → **Variables**, add:
   - `PRIVATE_KEY` — the dedicated wallet's private key
   - `RPC_URL` — your Alchemy/QuickNode URL (skip to use the public one)
4. It auto-deploys and runs `npm start`. Watch it work in the **Logs** tab.

## Reading the logs
- `window opens in Xmin` — sleeping until the next round
- `pre-signed nonce N …` — armed, 20s out
- `fired 0x…` — shot taken
- `🔥 WON the window` — you got the burn + reward
- `lost the window — rival landed` — they beat you (see tuning)
- `furnace out of fuel` — contract's CLAWD balance is below burn size; checks again every 30min

## Tuning (env vars)
| var | default | when to change |
|---|---|---|
| `PRIORITY_GWEI` | 0.2 | Losing while your tx lands in the same block? Raise it (0.5, 1.0). Costs are still fractions of a cent. |
| `LEAD_MS` | 900 | Losing because your tx misses the eligible block entirely? Raise to 1200-1500. Getting "too early" reverts? Lower to 600. |
| `GAS_LIMIT` | 200000 | Leave it. Observed usage is ~107k. |

Start with defaults, watch 2-3 windows, adjust one variable at a time.
