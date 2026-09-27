# TimeStream

Second-granular streaming payment escrow for freelance work, on **Monad testnet**.

A client locks up the full fee in an ERC-20 up front. The freelancer accepts the
job, which starts the clock, and payment accrues linearly with wall time. There
is no heartbeat to send and nothing to keep alive — if the freelancer goes quiet
the money keeps accruing. Stopping early is the client's call, via
`stopStream`, at any second.

- **Contract:** [`src/TimeStream.sol`](src/TimeStream.sol)
- **Network:** Monad Testnet — chain id `10143`
- **RPC:** `https://testnet-rpc.monad.xyz`
- **Explorer:** https://testnet.monadscan.com
- **Solidity:** `^0.8.20`, Foundry, OpenZeppelin v5.1.0

---

## How a stream works

| Step | Actor | Call | Effect |
| --- | --- | --- | --- |
| 1 | client | `createStream(...)` | Escrows `totalAmount` via `transferFrom`. Clock not started. |
| 2 | freelancer | `acceptStream(id)` | Starts the clock: `startTime = now`, `endTime = now + duration`. |
| 3 | freelancer | `withdraw(id)` | Pulls everything accrued so far (net of what was already withdrawn). |
| 4 | client | `stopStream(id)` | Optional early exit. Pays the freelancer what accrued, refunds the rest. |

Nothing is earned before `acceptStream`, and a stream the freelancer never
accepts is fully refundable by the client at any time.

### Accrual formula

```
effectiveEnd = min(block.timestamp, endTime)
elapsed      = effectiveEnd > startTime ? effectiveEnd - startTime : 0
earned       = totalAmount * elapsed / duration
withdrawable = earned - withdrawn
```

There is no third term clamping `effectiveEnd`. See *Why there is no check-in*
below.

---

## API

| Function | Caller | Notes |
| --- | --- | --- |
| `createStream(freelancer, token, totalAmount, durationSeconds) → streamId` | client | Pulls `totalAmount` with `transferFrom`; the client must approve first. |
| `acceptStream(streamId)` | freelancer | Starts the clock. Reverts if already accepted or stopped. |
| `earnedAmount(streamId) → uint256` | anyone | Withdrawable remainder, already net of `withdrawn`. `0` before accept. |
| `withdraw(streamId) → amount` | freelancer | Reverts `NothingToWithdraw` if nothing accrued. |
| `stopStream(streamId) → refundToClient` | client | Pays freelancer + refunds client, sets `active = false`. |
| `getStream(streamId)` | anyone | All 9 fields, in declaration order. |
| `streamDuration(streamId)` / `streamCount()` | anyone | Duration seconds; number of streams created. |

### Events

`StreamCreated`, `StreamAccepted`, `Withdrawn`, `StreamStopped`.

Each carries `streamId` as its first `indexed` field, so an activity feed can
filter by stream without decoding every log.

---

## Security

**Reentrancy.** The contract applies checks-effects-interactions rigorously:
every function that moves tokens writes its state *before* the external call,
and no external call's return value feeds a state decision.

Deliberate deviation: OpenZeppelin 5.1's `ReentrancyGuard` was **not** used
because it is built on EIP-1153 transient storage (`TSTORE`), which is not
guaranteed available across Monad EVM revisions. CEI gives the same protection
here without that dependency. Transfer helpers are OpenZeppelin `SafeERC20`, so
non-standard ERC-20s that omit a `bool` return are handled.

**Escrow accounting is strictly per-stream.** The contract pools the balance of
every stream it holds, so no payout decision may read
`token.balanceOf(address(this))` — that would let one stream's refund eat
another stream's escrow. `stopStream` derives the refund from the stream's own
fields: `totalAmount - (withdrawn + amountFreelancer)`. Integer-rounding dust
therefore stays with the client rather than getting stuck in the contract.

**Overflow.** `Math.mulDiv` does the accrual multiply in 512-bit, so a large
`totalAmount` cannot overflow the calculation. `endTime` is `startTime +
duration` and both are bounded by the caller-supplied `durationSeconds`.

**Keys.** No private key is read from an environment variable, a file, or a
constructor argument anywhere in this repo. See *Deploying* below.

---

## Build and test

```bash
forge build
forge test -vv
```

17 tests, all passing. Coverage includes the full
`create → accept → warp → withdraw → stop` lifecycle, the fact that accrual does
**not** cap while the freelancer is silent, the `endTime` ceiling, access
control on every role-restricted function, validation rejects, and multi-stream
escrow isolation.

---

## Why there is no check-in

> **Design note.** Earlier revisions of this contract required the freelancer to
> call `checkIn` at least once per `checkInInterval` seconds, and capped earnings
> at `lastCheckIn + checkInInterval` otherwise. That mechanism has been
> **removed** — `checkIn()`, `CheckedIn`, `lastCheckIn`, `checkInInterval` and
> the `checkInIntervalSeconds` argument to `createStream` no longer exist, and
> `earnedAmount` is now a pure function of wall time.
>
> The reason is that it was solving a trust problem it could not actually
> solve. A heartbeat only proves that *someone* touched a button on a
> schedule; it says nothing about whether the work was being done. Whether a
> freelancer is delivering is a matter of human relationships and ongoing
> communication between the two parties — a mechanism that cannot observe that
> adds no guarantee, it only adds friction: a mandatory transaction on a
> deadline, a failed wallet or a lost key silently freezing someone's pay, and
> a whole class of support questions about money that has stopped moving.
>
> The real protection was never the heartbeat. The client can `stopStream` at
> any instant and take back everything that has not accrued yet, which is a
> stronger and more direct guarantee than an absence-of-signal check, and it
> costs the freelancer nothing to keep. So the heartbeat went, and the
> protection stayed.

---

## Deploying

### 1. Create an encrypted keystore (interactive, once)

```bash
cast wallet import timestream-deployer --interactive
```

This writes an encrypted keystore to `~/.foundry/keystore/timestream-deployer`.
The private key is typed at the prompt and is never passed as an argument, so it
never lands in shell history, a `.env` file, or the repository.

> There is deliberately no scripted alternative here. Do not substitute
> `forge script --private-key`, `--mnemonic`, or a `PRIVATE_KEY` env var.

### 2. Fund it with testnet MON

```bash
cast balance $(cast wallet address --account timestream-deployer) --rpc-url monad_testnet
```

If it reads `0`, top it up from the [Monad faucet](https://faucet.monad.xyz)
before deploying.

### 3. Deploy

```bash
forge script script/DeployTimeStream.s.sol:DeployTimeStream \
  --rpc-url monad_testnet \
  --account timestream-deployer \
  --broadcast
```

Add `--verify` to publish the source on the explorers.

The script asserts `block.chainid == 10143` and reverts otherwise, so it cannot
accidentally broadcast to the wrong network. Signing is injected by forge from
the `--account` keystore, which is why `vm.startBroadcast()` is called with no
argument.

To rehearse without spending gas, drop `--broadcast`; forge simulates against
the live testnet and prints the estimate.

### 4. Generate `deployment.json`

```bash
node script/gen-deployment-json.mjs
```

Writes `deployment.json` for the frontend team — `address`, `abi`, `chainId`,
`rpcUrl`, plus `explorerUrl`, `deployTxHash` and the USDC reference. The ABI is
read from the compiled artifact and the address from forge's broadcast record,
so the file cannot drift from what was actually deployed.

It writes **two** files from one in-memory object, never building the JSON
twice:

| Path | Role |
| --- | --- |
| `back/deployment.json` | canonical |
| `flowpay-ui/deployment.json` | the copy the frontend imports |

The duplicate is not optional. The Vercel project is rooted at `flowpay-ui`, so a
build there never sees `../back/` and fails to resolve an import that reaches
outside its own directory — which is exactly how it failed before this file
existed. The frontend therefore imports its local copy through the
`@deployment` alias, and `flowpay-ui/scripts/check-deployment-sync.mjs` runs at
the top of every frontend `dev` and `build`, failing the build if the two copies
ever diverge. Re-running this script is the only way to change them; do not edit
either file by hand.

### 5. Deploy the frontend

```bash
cd ../flowpay-ui && npx vercel deploy --prod
```

`flowpay-ui/vercel.json` pins the output directory to `dist/public`. Without it
Vercel's Vite preset serves `dist/`, whose root holds the Express bundle built
by `esbuild`, and the site answers `/` with JavaScript source instead of the app.

---

## Test USDC

Streams are denominated in **Circle USDC on Monad testnet**:

```
0x534b2f3A21130d7a60830c2Df862319e593943A3   (6 decimals)
```

Source: [`monad-crypto/token-list`](https://github.com/monad-crypto/token-list/blob/main/tokenlist-testnet.json).
Verified on-chain: the address holds code and reports `decimals() == 6` and
`symbol() == "USDC"`. This is the real token — no stand-in is deployed anywhere
in this project.

**Get some:** [faucet.circle.com](https://faucet.circle.com) → network *Monad
Testnet* → *USDC* → 20 USDC per address per 2 hours. Native testnet MON for gas
comes from the [Monad faucet](https://faucet.monad.xyz).

`test/mocks/MockERC20.sol` exists solely to drive the unit tests on an ephemeral
EVM. It has a public `mint`, is never deployed to a public network, and is not
part of the product flow.

---

## Layout

```
src/TimeStream.sol               the escrow contract
script/DeployTimeStream.s.sol    forge script, keystore-only signing
script/gen-deployment-json.mjs   writes deployment.json
test/TimeStream.t.sol            17 tests
test/mocks/MockERC20.sol         unit-test token only
deployment.json                  generated after deploy (canonical)
../flowpay-ui/deployment.json    generated copy the frontend imports
```

---

## Design notes

**`streamDuration` is a separate mapping.** The stream record is the exact
9 fields that were specified. There is no `duration` field among them, yet
`acceptStream` must set `endTime = startTime + duration` — and `duration` cannot
be recovered before `startTime` exists. It is therefore kept in its own public
mapping rather than widening the struct.

**Events carry `streamId`.** The event list was specified by shape
(`Withdrawn(uint256 amount)`, `StreamStopped(uint256 refundToClient)`). An event
without the stream id is not indexable, so `streamId` was added as the first
`indexed` parameter to every one of them, keeping the specified payload fields
in place.
