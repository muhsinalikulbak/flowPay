# TimeStream

Second-granular streaming payment escrow for freelance work, on **Monad testnet**.

A client locks up the full fee in an ERC-20 up front. The freelancer accepts the
job, which starts the clock, and payment accrues linearly with wall time. The
freelancer has to `checkIn` at least once per `checkInInterval` seconds to keep
accruing — that heartbeat is what makes this *streaming* rather than a plain
vesting schedule. Go silent and you stop being paid.

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
| 2 | freelancer | `acceptStream(id)` | Starts the clock: `startTime = now`, `endTime = now + duration`, `lastCheckIn = now`. |
| 3 | freelancer | `checkIn(id)` | Resets the accrual cap to `now`. Repeat every `checkInInterval`. |
| 4 | freelancer | `withdraw(id)` | Pulls everything accrued so far (net of what was already withdrawn). |
| 5 | client | `stopStream(id)` | Optional early exit. Pays the freelancer what accrued, refunds the rest. |

Nothing is earned before `acceptStream`, and a stream the freelancer never
accepts is fully refundable by the client at any time.

### Accrual formula

```
effectiveEnd = min(block.timestamp, lastCheckIn + checkInInterval, endTime)
elapsed      = effectiveEnd > startTime ? effectiveEnd - startTime : 0
earned       = totalAmount * elapsed / duration
withdrawable = earned - withdrawn
```

The `lastCheckIn + checkInInterval` term is the heartbeat cap. Without it,
`effectiveEnd` would simply be `min(now, endTime)`.

---

## API

| Function | Caller | Notes |
| --- | --- | --- |
| `createStream(freelancer, token, totalAmount, durationSeconds, checkInIntervalSeconds) → streamId` | client | Pulls `totalAmount` with `transferFrom`; the client must approve first. |
| `acceptStream(streamId)` | freelancer | Starts the clock. Reverts if already accepted or stopped. |
| `checkIn(streamId)` | freelancer | Requires `accepted && active`. |
| `earnedAmount(streamId) → uint256` | anyone | Withdrawable remainder, already net of `withdrawn`. `0` before accept. |
| `withdraw(streamId) → amount` | freelancer | Reverts `NothingToWithdraw` if nothing accrued. |
| `stopStream(streamId) → refundToClient` | client | Pays freelancer + refunds client, sets `active = false`. |
| `getStream(streamId)` | anyone | All 11 fields, in declaration order. |
| `streamDuration(streamId)` / `streamCount()` | anyone | Duration seconds; number of streams created. |

### Events

`StreamCreated`, `StreamAccepted`, `CheckedIn`, `Withdrawn`, `StreamStopped`.

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

**Overflow.** `Math.mulDiv` does the accrual multiply in 512-bit, and
`lastCheckIn + checkInInterval` uses a saturating add, so neither a large
`totalAmount` nor an absurd `checkInInterval` can overflow.

**Keys.** No private key is read from an environment variable, a file, or a
constructor argument anywhere in this repo. See *Deploying* below.

---

## Build and test

```bash
forge build
forge test -vv
```

17 tests, all passing. Coverage includes the full
`create → accept → warp → withdraw → stop` lifecycle, the check-in cap, access
control on every role-restricted function, validation rejects, and
multi-stream escrow isolation.

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
deployment.json                  generated after deploy
```

---

## Design notes

**`streamDuration` is a separate mapping.** The stream record is the exact
11 fields that were specified. There is no `duration` field among them, yet
`acceptStream` must set `endTime = startTime + duration` — and `duration` cannot
be recovered before `startTime` exists. It is therefore kept in its own public
mapping rather than widening the struct.

**Events carry `streamId`.** The event list was specified by shape
(`Withdrawn(uint256 amount)`, `StreamStopped(uint256 refundToClient)`). An event
without the stream id is not indexable, so `streamId` was added as the first
`indexed` parameter to every one of them, keeping the specified payload fields
in place.
