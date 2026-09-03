# Bounded delegation on GIWA Sepolia

Measured 2026-09-03 against `https://sepolia-rpc.giwa.io` (chain 91342).

A HybridDeleGator account on this chain accepted a bounded ERC-7710
delegation, paid 0.001 ETH inside the cap, and refused 0.01 ETH with
`NativeTokenTransferAmountEnforcer:allowance-exceeded`. After
`disableDelegation`, the same in-bounds redeem was refused with
`CannotUseADisabledDelegation()`. Adding a P-256 key did not change the
account address.

That first loop does not change custody. While Flizy is `owner()`, every
caveat is theatre: the owner can `execute` through EntryPoint and ignore
the delegation. Do not read "delegation works" as "Flizy is no longer
custodial."

The second loop is the custody proof. A P-256 key was added, the EOA
owner was renounced to `address(0)`, and the address stayed
`0x71055FF6aD1a792FD1b213BD00ac50ba4B40bda1`. After that, the Flizy
delegate still paid 0.001 ETH inside the cap. The former owner could
not: `handleOps` mined status 0 with `FailedOp(0, "AA24 signature error")`.
Owner ECDSA ERC-1271 died (`0xffffffff`). P-256 ERC-1271 stayed
`0x1626ba7e`.

This is a chain measurement. It is not a product cutover. Production
still signs derived EOAs. The experiment account is not a user or tester
wallet. No production account address was written.

Companion to `docs/PASSKEY-P256-GIWA.md` (P-256 / WebAuthn on this chain).
Addresses: `deployments/giwa-sepolia-delegation.json`.
Script for the custody loop: `scripts/delegation-giwa-renounce.js`.

---

## 1. What was measured

One hypothesis, one experiment:

1. Deploy DelegationManager, HybridDeleGator implementation, SimpleFactory,
   and the three caveat enforcers this test needs, from MetaMask
   `delegation-framework` **v1.3.0** only, onto GIWA Sepolia only.
2. Create one HybridDeleGator. Owner is the Flizy ops EOA. No passkey
   flow. Predict the address, then confirm the deployed address matches.
3. Add a P-256 key. Read the address from chain before and after.
4. Issue a delegation to a separate Flizy delegate key with a native-value
   cap, an allowed target, and an expiry. Redeem under the cap (Case A)
   and over the cap (Case B). Change only the amount.
5. Disable the delegation on the DelegationManager. Replay Case A
   unchanged.
6. Ask whether the delegate can still move funds, and whether the owner
   can still bypass every caveat.
7. Second loop: add a P-256 key whose private key is kept locally, sign
   a new bounded delegation with that key, `renounceOwnership`, then
   prove the delegate still executes inside the bound and the former
   owner cannot execute outside it.

Scripts: `scripts/delegation-giwa-experiment.js` (first loop),
`scripts/delegation-giwa-renounce.js` (custody loop),
`scripts/delegation-giwa-code.js` (canonical CREATE2 `eth_getCode`),
`scripts/delegation-giwa-bytecode.js` (runtime vs v1.3.0 artifact).

---

## 2. Pinned release

Repo: https://github.com/MetaMask/delegation-framework

GitHub tagged releases on that repo: `v1.0.0`, `v1.1.0`, `v1.2.0`,
`v1.3.0`. **`v1.3.0` is still Latest** as of this measurement. No newer
audited tag exists, so nothing was switched.

| Field | Value |
| --- | --- |
| Tag | `v1.3.0` |
| Commit | `bfbdf9795a976833ed2fa000baf42fbb83958b03` |
| Published | 2025-07-24T17:12:13Z |
| Contract `VERSION` | `"1.3.0"` in `src/HybridDeleGator.sol` |

README of that tag:

> We use tags for audited versions of code releases and the `main` branch is the working development branch.

Nothing below was read from `main`. Artifacts were compiled from a local
clone of that tag with the tag's Foundry config (solc 0.8.23). Runtime
metadata tails on the matching contracts read `solc 0.8.23`
(`63430008170033`).

Canonical CREATE2 addresses from `documents/Deployments.md` at the tag
(salt `"GATOR"`):

```
SimpleFactory:          0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c
DelegationManager:      0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
HybridDeleGatorImpl:    0x48dBe696A4D990079e039489bA2053B36E8FFEC4
AllowedTargetsEnforcer: 0x7F20f61b1f09b08D970938F6fa563634d65c4EeB
```

GIWA / chain 91342 is not in that file's chain list.

---

## 3. What was deployed

### Canonical CREATE2 is still empty

`eth_getCode` on 2026-09-03, same RPC:

| Name | Address | Bytecode bytes |
| --- | --- | --- |
| SimpleFactory | `0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c` | 0 |
| DelegationManager | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` | 0 |
| HybridDeleGatorImpl | `0x48dBe696A4D990079e039489bA2053B36E8FFEC4` | 0 |
| AllowedTargetsEnforcer | `0x7F20f61b1f09b08D970938F6fa563634d65c4EeB` | 0 |
| AllowedCalldataEnforcer | `0xc2b0d624c1c4319760C96503BA27C347F3260f55` | 0 |
| AllowedMethodsEnforcer | `0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5` | 0 |

Mapae has claimed roughly 38 Delegation Framework units on this chain.
Those canonical addresses are not among them: they have zero bytecode.
A bytecode-identical v1.3.0 copy at a non-canonical address was not
found in this measurement, because this measurement did not scan the
whole chain. Reusing a correct copy would have been better than adding
a second. The ops-key deploys below are a second copy, at different
addresses, because the deployer is not MetaMask's CREATE2 deployer.

EntryPoint v0.7 is already on this chain:
`0x0000000071727De22E5E9d8BAf0edAc6f37da032` (16035 bytes).

### Ops-key deploys (GIWA Sepolia only)

Deployer: `0x81Fb7Ed21B9843D2D5C232A7F3e959F91993401B` (ops).

Bytecode comparison is keccak of `eth_getCode` against the v1.3.0
artifact `deployedBytecode`, not a name on an explorer.

| Contract | Address | Bytes | Exact keccak vs artifact | Deploy tx |
| --- | --- | --- | --- | --- |
| SimpleFactory | `0x78F5d9AC0aB718dE8AEA78F2E7E8864688F9c051` | 751 | yes | `0x4c39e81c331e14c2ac4e4259867bf8f631ce54e0031c0b3039e407204c59fb27` |
| DelegationManager | `0xB04c9b180d5C0F9854B3f9da5e702d10f0030d4B` | 11503 | no (constructor immutables) | `0xb0180838ede1174550a45add91cf3ac449a8afe8da132b68c850b00939846c31` |
| SCL_RIP7212 | `0x2E5d71461951B459aE837714a9EB143c0f2548F9` | 3223 | no (library self-address) | `0xdebad914684f9c7b688a900768f7e43e92cdd1ff56646204323255588412e24f` |
| HybridDeleGator impl | `0xC12F82BBbD43aA77371D9121acDF088224D4cC0c` | 20203 | no (immutables + library link) | `0x681a104c5fa4a78464dc44b3acd4916958724d653b38d62eb389ccdf4b807cef` |
| NativeTokenTransferAmountEnforcer | `0x163bD4BDcb68c4913deeFFa265ec54007d6C03CF` | 1485 | yes | `0x77a619f4a78b623ff9802a8d3c176bad8673cbbe6c1a5c0904a0f8bca45c7d08` |
| TimestampEnforcer | `0x24DD7326ae2275fD9D505526f62a3843d174C2eF` | 1255 | yes | `0x540e9f8f8176a9529966c9cc8c8550e4b6008b34bf207d04aaca82f1c080560e` |
| AllowedTargetsEnforcer | `0x6b50AD84c6Ba42d227bD8f88bCdC4B53d3fdA405` | 1846 | yes | `0x2a16a8ce44df870f65132bf4d9441446974d3ee72526e0c0562680e1230931fc` |

Exact keccak match, confirmed by a second `eth_getCode` on 2026-09-03:
SimpleFactory, NativeTokenTransferAmountEnforcer, TimestampEnforcer,
AllowedTargetsEnforcer. Metadata-stripped comparison also matches.

Mismatches that are expected, not a wrong binary:

- **DelegationManager.** Constructor writes `owner` as an immutable.
  Runtime length equals the artifact (11503). keccak differs because
  the baked owner is the ops EOA, not the artifact placeholder.
- **SCL_RIP7212.** Solidity library. On-chain start is
  `0x73` + this contract's own 20-byte address. The artifact starts
  `0x73` + twenty zero bytes. 20 bytes differ, first differing byte at
  offset 1. The rest, including the solc 0.8.23 metadata tail, is
  identical. Length 3223 both sides.
- **HybridDeleGator.** `deployedBytecode` in the artifact still contains
  the `SCL_RIP7212` link placeholder. After splicing the library
  address, runtime still differs because the constructor bakes
  DelegationManager and EntryPoint as immutables. On-chain code
  contains all three addresses (SCL, DelegationManager, EntryPoint).
  Length 20203 both sides.

Creation bytecode for HybridDeleGator was the v1.3.0 artifact with the
SCL library address linked in before deploy. The unlinked artifact
cannot be sent as `tx.data`.

Nothing was deployed to any other chain.

---

## 4. One account

Owner is the ops EOA. No passkey was used as a signer. That matches the
locked onboarding: chat signup means Flizy is the EOA owner first.

The account is an ERC-1967 proxy, deployed through SimpleFactory with
salt `1` and init `initialize(ops, [], [], [])`.

| | |
| --- | --- |
| Predicted | `0x71055FF6aD1a792FD1b213BD00ac50ba4B40bda1` |
| Deployed | `0x71055FF6aD1a792FD1b213BD00ac50ba4B40bda1` |
| Match | exact |
| Deploy tx | `0x104ee25c8c85b3873f42d5583b579001405c0de6a7c98876ae10941998f08161` |
| Block | 35117949 |
| Receipt status | 1 |
| From | ops |
| To | SimpleFactory |
| Proxy code | 170 bytes |
| `owner()` | `0x81Fb7Ed21B9843D2D5C232A7F3e959F91993401B` |

Predicted was `SimpleFactory.computeAddress(keccak256(proxyBytecode), salt)`
before the deploy tx was sent. The deployed address was that return
value. `eth_getCode` at that address after the receipt is non-empty.

This address is not a user wallet. Do not give it to testers.

---

## 5. Address stability

The property that killed `FlizyWallet.sol` is CREATE2 baking the owner
into the address. If adding a key or rotating the owner moved this
account, the upgrade path (add passkey, same address, no sweep) would
be impossible.

What was done: `addKey("measure-p256", x, y)` via an owner-signed
PackedUserOperation through EntryPoint v0.7. The P-256 point is a Node
`crypto.generateKeyPairSync` key, not a browser authenticator. It was
added to storage. It was not used to sign anything.

| | Before `addKey` | After `addKey` |
| --- | --- | --- |
| Address | `0x71055FF6aD1a792FD1b213BD00ac50ba4B40bda1` | `0x71055FF6aD1a792FD1b213BD00ac50ba4B40bda1` |
| Runtime keccak | `0xeea896c7b0a3442ea3a79a89e5109ac4e63728ec288722197f6391cd6112aa74` | `0xeea896c7b0a3442ea3a79a89e5109ac4e63728ec288722197f6391cd6112aa74` |
| `owner()` | ops | ops |
| `getKeyIdHashesCount()` | 0 | 1 |

`addKey` tx: `0x157e75ce595f7d8fd3eeb4ab3699a75fac26ea263ce72fa7688a7d605a87bbb7`
block 35118178, status 1, to EntryPoint, gas 219155.

A second `eth_getCode` on 2026-09-03 at the same address still hashes to
`0xeea896c7...`. `owner()` is still ops. `getKeyIdHashesCount()` is
still 1.

The address did not move. Runtime bytecode did not move. Keys live in
storage on the proxy.

This step added a key. It did not change `owner()`. Address stability
under `renounceOwnership` is section 12, not an inference from this
table.

---

## 6. Bounds test, with a paired control

Delegation from the account to a separate ephemeral delegate EOA.

| Field | Value |
| --- | --- |
| Delegate | `0x8Eb361De0403Debc77D53D1a18502a48a142A18c` |
| Sink / allowed target | `0x78592B6147b2B8E7bb9Bb477AE10040cf01867D7` |
| Cap | 0.005 ETH |
| Case A amount | 0.001 ETH |
| Case B amount | 0.01 ETH |
| Authority | root (`bytes32(type(uint256).max)`) |
| Salt | 1 |
| EIP-712 domain | DelegationManager, name `DelegationManager`, version `1`, chain 91342 |
| Signature | ops EOA (account owner) over that typed data |

Caveats, all present on both cases:

1. `NativeTokenTransferAmountEnforcer` terms = `abi.encode(uint256 cap)`
2. `TimestampEnforcer` terms = after `0`, before `now + 1 day`
3. `AllowedTargetsEnforcer` terms = the sink address

Call path: the delegate EOA calls `DelegationManager.redeemDelegations`
directly. That is a normal transaction, not a UserOp. It is the hot
path the locked design wants for chat sends.

The only difference between A and B is the native value in the
execution. Same account, same delegation, same delegate, same target,
same calldata shape (`encodeSingle(sink, value, 0x)`), same gas
strategy.

### Case A, in bounds (0.001 ETH)

Receipt, re-read from chain:

```
hash:    0x045681b8ac3a61552da8f33a6968bcf08760dfed404008c333618cbe99722b96
status:  1
block:   35118317
from:    0x8Eb361De0403Debc77D53D1a18502a48a142A18c   (delegate)
to:      0xB04c9b180d5C0F9854B3f9da5e702d10f0030d4B   (DelegationManager)
gasUsed: 193227
```

Balances around that tx:

```
sinkDelta:     +1000000000000000
accountDelta:  -1000000000000000
```

0.001 ETH moved from the account to the sink. The account delta is
exactly the value. Gas for the outer tx was paid by the delegate EOA.

### Case B, out of bounds (0.01 ETH)

The RPC rejected the same call at `eth_estimateGas` / `eth_call`. No
transaction was broadcast. There is no mined failed receipt. Value did
not move (`sinkDelta 0`, `accountDelta 0`).

Revert data on that error:

```
selector: 0x08c379a0
string:   NativeTokenTransferAmountEnforcer:allowance-exceeded
raw:      0x08c379a0
          0000000000000000000000000000000000000000000000000000000000000020
          0000000000000000000000000000000000000000000000000000000000000034
          4e6174697665546f6b656e5472616e73666572416d6f756e74456e666f726365
          723a616c6c6f77616e63652d6578636565646564000000000000000000000000
```

`0x08c379a0` is `Error(string)`. The string is 52 bytes (`0x34`), which
is exactly `NativeTokenTransferAmountEnforcer:allowance-exceeded`.

That string is the `require` in v1.3.0
`src/enforcers/NativeTokenTransferAmountEnforcer.sol` line 57:

```
require(spent_ <= allowance_, "NativeTokenTransferAmountEnforcer:allowance-exceeded");
```

This is not an ABI mismatch, a missing approval, an out-of-gas, or a
bad encoding. Those would not produce this enforcer's own revert
string. An encoding mistake that broke both cases is ruled out by
Case A succeeding with the same ABI.

A mined failed receipt would be stronger evidence of inclusion cost.
It was not produced. Attribution of the revert reason does not depend
on inclusion: the node returned the enforcer's revert data on the
same call Case A mined.

Timestamp and allowed-target caveats were on the delegation. They were
not the A/B axis. Both calls sat inside the time window and used the
allowed sink.

---

## 7. Revoke

`DelegationManager.disableDelegation` was invoked by the account via
an owner-signed UserOp (`execute` targeting the manager). That is
owner-authorized. The delegate cannot disable.

```
hash:    0xe27f9b771cb273250d744dfd57857846d1f1a62a300240d4bbf6b3c63b0bdbed
status:  1
block:   35118334
from:    0x81Fb7Ed21B9843D2D5C232A7F3e959F91993401B   (ops)
to:      0x0000000071727De22E5E9d8BAf0edAc6f37da032   (EntryPoint v0.7)
gasUsed: 147214
```

Case A replayed unchanged (same 0.001 ETH, same delegation, same
delegate, same target). RPC rejected at `eth_estimateGas` / `eth_call`.
No mined receipt. Value did not move.

Revert data:

```
selector: 0x05baa052
custom:   CannotUseADisabledDelegation()
raw:      0x05baa052
```

`keccak256("CannotUseADisabledDelegation()")` first four bytes is
`0x05baa052`. That error is declared on
`IDelegationManager` and thrown in v1.3.0 `DelegationManager.sol`
when `disabledDelegations[hash]` is set, before caveats run.

This is a disabled-delegation failure, not the amount enforcer, not
an ABI error, and not out-of-gas.

---

## 8. God-key

### Delegate, after revoke

A further `redeemDelegations` from the same delegate, same in-bounds
amount, returned the same `0x05baa052` / `CannotUseADisabledDelegation()`.
The redeem path is closed.

`DeleGatorCore.execute(...)` is `onlyEntryPoint`.
`DeleGatorCore.executeFromExecutor(...)` is `onlyDelegationManager`.
The delegate is neither. Those two functions were not called by the
delegate in this test. They are gated in source.

This measurement did not enumerate every other selector on the account
(upgrade, `withdrawDeposit`, `enableDelegation`, and so on). Those
are `onlyEntryPointOrSelf` in v1.3.0, so they also require an owner
UserOp or a self-call. See section 11.

### Owner, after revoke

At this point in the first loop the ops key was still `owner()`. That
was read from chain after `addKey`.

The owner moved 0.001 ETH from the account to the sink with
`execute((address,uint256,bytes))` through EntryPoint `handleOps`.
Caveats were not consulted. That is expected: caveats bind the
delegation, not the owner.

```
hash:    0x99852c2d0f26145dcc07dba7332294aa3266cd068bcd314d94a7c219f1de9cf0
status:  1
block:   35118351
from:    ops
to:      EntryPoint v0.7
gasUsed: 98873
```

The owner did not call `execute` as a raw EOA transaction. `execute` is
`onlyEntryPoint`, so the owner signs a PackedUserOperation (HybridDeleGator
EIP-712 domain, version `1`) and ops submits `handleOps`. Same privilege,
different wrapper.

This test is not proof of non-custodial behaviour. While Flizy is
owner, every caveat is theatre. That is exactly why the locked design
has Flizy issue the bounded delegation and then renounce owner after
the passkey is added. Sections 6 and 7 were measured with Flizy still
owner. They prove the chain will enforce caveats against a *delegate*.
They do not prove Flizy has given up the god-key. That proof is
section 12.

---

## 9. What is confirmed

- `v1.3.0` is still the latest tagged, audited MetaMask
  delegation-framework release. No newer audited tag was found.
- Canonical CREATE2 addresses for DelegationManager, HybridDeleGatorImpl,
  SimpleFactory, and the listed enforcers have zero bytecode on GIWA
  Sepolia.
- Ops-deployed SimpleFactory, NativeTokenTransferAmountEnforcer,
  TimestampEnforcer, and AllowedTargetsEnforcer have keccak-identical
  runtime to the v1.3.0 artifacts.
- One HybridDeleGator proxy was created at a CREATE2 address that
  matched the factory's prediction exactly.
- Adding a P-256 key left the account address and runtime bytecode
  unchanged. After the first `addKey`, `owner()` was still the ops
  EOA. Key count went 0 to 1, then 2 when the root key was added.
- A bounded delegation can be redeemed on this chain as a normal
  transaction from the delegate EOA to DelegationManager. Case A
  mined, status 1, 0.001 ETH moved.
- The same redeem over the native cap is refused by
  `NativeTokenTransferAmountEnforcer:allowance-exceeded`.
- After `disableDelegation`, the previously-succeeding redeem is
  refused by `CannotUseADisabledDelegation()` (`0x05baa052`).
- The owner can still move funds, bypassing every caveat, via an
  EntryPoint UserOp, **until owner is `address(0)`**. After renounce
  (section 12) that path is closed.
- `renounceOwnership` left the account address and runtime keccak
  unchanged. `owner()` became `address(0)`.
- After that, a P-256-signed bounded redeem still mined (0.001 ETH).
  The same redeem over the cap still named
  `NativeTokenTransferAmountEnforcer:allowance-exceeded`.
- The former owner's `handleOps` mined status 0 with
  `FailedOp(0, "AA24 signature error")`. Owner ECDSA ERC-1271 on the
  delegation hash went from `0x1626ba7e` to `0xffffffff`. P-256 stayed
  `0x1626ba7e`.

---

## 10. What remains unverified

- **Hardware / browser WebAuthn.** The root key is a Node
  `crypto.generateKeyPairSync` P-256 key. The signature used here is
  the raw 96-byte branch (`sha256(abi.encodePacked(hash))` then
  RIP-7212), not the WebAuthn JSON branch. Format verification of
  WebAuthn on this chain is in `docs/PASSKEY-P256-GIWA.md`.
- **Mined failed receipts** for amount-cap refusals. Case B before
  and after renounce were refused at `eth_estimateGas` / `eth_call`.
  The former-owner execute *was* mined status 0. Different path.
- **Expiry and allowed-target as the varying variable.** Both
  enforcers were on the delegation. Only the amount changed between
  A and B. A wrong-target redeem and an expired redeem were not run.
- **ERC-20 amount limits.** Native value only.
- **Delegate paths other than `redeemDelegations`.** Selectors on the
  account were not brute-forced.
- **ERC-4337 bundler / paymaster.** `handleOps` was submitted by ops
  as a normal tx. No third-party bundler.
- **A bytecode-identical v1.3.0 copy elsewhere on this chain.**
  Canonical CREATE2 is empty. The rest of the address space was not
  scanned. Mapae's claimed units were not inventoried.
- **Production engine, freeze, recovery, step-up page, tester
  cutover.** Out of scope. Not built.

---

## 11. Inferences (labeled)

- Inference: the chat-first upgrade path (create account as Flizy EOA
  owner, later add a passkey, keep the address) is possible on this
  chain. Supported by `addKey` and by `renounceOwnership` leaving
  address and runtime keccak identical.
- Inference: after revoke, the delegate cannot move funds from this
  account. Supported by `redeemDelegations` reverting
  `CannotUseADisabledDelegation()`, and by `execute` /
  `executeFromExecutor` being gated to EntryPoint and
  DelegationManager in v1.3.0 source. Not supported by a full
  selector sweep.
- Inference: a production chat send on this chain can be a relayer
  EOA calling `redeemDelegations`, with no bundler on the hot path.
  Supported by Case A both before and after renounce (delegate ->
  DelegationManager, status 1, value moved). Not a measurement of
  Policy, receipts, or the engine.
- Inference: Flizy's long-lived bounded delegation must be signed by
  a key that remains a signer after renounce, i.e. the passkey, not
  the EOA owner. Supported by ERC-1271 on the same typed hash: owner
  ECDSA was `0x1626ba7e` before renounce and `0xffffffff` after; P-256
  stayed `0x1626ba7e`. DelegationManager checks `isValidSignature` at
  redeem time, not at sign time. A 65-byte ops signature would have
  made the delegate dead after `renounceOwnership`.
- Inference: after owner is `address(0)`, caveats are load-bearing
  against Flizy. Supported by in-bounds redeem succeeding and former
  owner `handleOps` mining status 0 with `AA24 signature error`. Not
  a claim that every other selector is closed.

---

## 12. Renounce: the custody proof

Same account as sections 4-8. No new proxy.

This is an architectural milestone, not a marketing claim. The
chain question is closed. Remaining work is the user-facing security
system around a transition already demonstrated on chain.

```
Proven on chain              Still to build
-------------------------    -----------------------------
core custody transition      hardware passkey ceremony
stable account identity      "Secure this account" UX
EOA authority removed        freeze
P-256 authority remains      recovery
bounded delegation executes  engine integration
                             migration
```

Permanent invariant:

```
add passkey -> sign bounded delegation with P-256 -> renounce EOA ownership
```

Account identity (the address) stayed. Control authority (who can move
funds) changed. Those are different claims. "Delegation works" is not
"the account is non-custodial."

DelegationManager validates ERC-1271 **at redeem**, not at sign.
Signing the new delegation with the ops EOA (65 bytes) would have
been valid while ops was owner and invalid the moment owner became
`address(0)`. The new delegation was therefore signed with the raw
P-256 branch (96 bytes: `abi.encode(keyIdHash, r, s)`). Preflight
refused to renounce unless that signature already returned
`0x1626ba7e`.

### Add key

| | |
| --- | --- |
| keyId | `root-p256` |
| Tx | `0x35d24c1945acbcd0dad9a8e75ac289e3b06759f9c8540916c2c8cfdb67b6c168` |
| Block | 35120355 |
| Receipt status | 1 |
| Event | `AddedP256Key` for `root-p256` |
| Key count | 2 (the first-loop `measure-p256` remains; its private key was discarded) |

P-256 ERC-1271 preflight, dummy hash: `0x1626ba7e`.

### Renounce

| | Before | After |
| --- | --- | --- |
| Address | `0x71055FF6aD1a792FD1b213BD00ac50ba4B40bda1` | `0x71055FF6aD1a792FD1b213BD00ac50ba4B40bda1` |
| Runtime keccak | `0xeea896c7b0a3442ea3a79a89e5109ac4e63728ec288722197f6391cd6112aa74` | `0xeea896c7b0a3442ea3a79a89e5109ac4e63728ec288722197f6391cd6112aa74` |
| `owner()` | ops | `0x0000000000000000000000000000000000000000` |
| Key count | 2 | 2 |
| P-256 `isValidSignature` on the delegation hash | `0x1626ba7e` | `0x1626ba7e` |
| Owner ECDSA `isValidSignature` on the same hash | `0x1626ba7e` | `0xffffffff` |

```
hash:    0x8c83363d6b9c28a3acb3a564c6e2b95763aa388a4f2de2720a0a1efdd6521a9a
status:  1
block:   35120460
from:    ops
to:      EntryPoint v0.7
gasUsed: 92558
```

The address did not move. If it had, the upgrade path would be dead.

### Inside the bound, after owner is zero

New delegate `0x0F5E4B95c6A8C1320516cA41f13db15FC96a178B`, new sink,
cap 0.005 ETH, in-bounds 0.001 ETH. Same caveat shape as section 6.
Signature is the 96-byte P-256 value, not ops ECDSA.

```
hash:    0x45347786e5c729f5c5e36ce0108cc9c2549d976a7665fb152389f21808bd743f
status:  1
block:   35120470
from:    0x0F5E4B95c6A8C1320516cA41f13db15FC96a178B   (delegate)
to:      0xB04c9b180d5C0F9854B3f9da5e702d10f0030d4B   (DelegationManager)
gasUsed: 201497
sinkDelta:    +1000000000000000
accountDelta: -1000000000000000
```

Flizy as bounded delegate still executes. No owner, no UserOp, no
bundler.

### Over the cap, after owner is zero

Same call, 0.01 ETH. RPC refused at `eth_estimateGas` / `eth_call`.
No mined receipt. Value did not move.

```
selector: 0x08c379a0
string:   NativeTokenTransferAmountEnforcer:allowance-exceeded
```

Caveats still bind with no owner present. This is not an ABI or gas
failure. Same honesty as section 6: attribution is the enforcer
string, not a mined failed receipt.

### Former owner, outside the bound

Ops, no longer `owner()`, submitted the same `execute` UserOp shape
that succeeded in section 8 (65-byte ECDSA over the HybridDeleGator
EIP-712 UserOp hash, `handleOps` from ops). Explicit `gasLimit` so
the node would mine a reverting tx rather than stop at estimate.

```
hash:    0x05bc107c3bf3037f8bde9920fd7dda83f22e3d6392ae87ab85ab3db63c9ad0cb
status:  0
block:   35120483
from:    ops
to:      EntryPoint v0.7
gasUsed: 76113
logs:    0
sinkDelta:    0
accountDelta: 0
```

`eth_call` of that same transaction:

```
selector: 0x220266b6
custom:   FailedOp(0, "AA24 signature error")
```

`0x220266b6` is `FailedOp(uint256,string)`. AA24 is the ERC-4337
signature-validation failure. That matches `isValidSignature`
returning `0xffffffff` for the ops ECDSA after owner is zero: length
65 recovers ops, `owner()` is `address(0)`, mismatch, validation
data 1, EntryPoint rejects.

This is a mined refusal with the signature-failure reason, not a
generic revert and not an amount-enforcer revert. The former owner
did not move funds.

### What this is not

- Not a browser passkey. Raw P-256, Node-generated.
- Not the engine. Chat still signs derived EOAs.
- Not a claim that ops can never move these funds some other way.
  A local P-256 private key was kept for this research account so it
  is not bricked. That key is gitignored and is not in this repo.
  Production must not store a user passkey private key on the server.
  That key exists here only because this is a chain test, not a user
  account.

