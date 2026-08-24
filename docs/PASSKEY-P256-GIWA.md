# P-256 / WebAuthn on GIWA Sepolia

Measured 2026-08-24 against `https://sepolia-rpc.giwa.io` (chain 91342).

A real WebAuthn-format P-256 signature verifies on GIWA Sepolia through the
MetaMask HybridDeleGator v1.3.0 library path (RIP-7212 at `0x100`). Per
signature: **75473 gas** for that WebAuthn branch on the probe; **30436 gas**
observed on the raw `0x100` call (`debug_traceCall.gasUsed`). Canonical
HybridDeleGatorImpl is **not** deployed on this chain.

This is a chain measurement. It is not a product cutover.

---

## 1. What was measured

1. Pin MetaMask `delegation-framework` to the latest tagged release that ships published audits.
2. Trace HybridDeleGator P-256 / WebAuthn verification in that tag.
3. Call `0x100` on GIWA Sepolia with a known-valid vector and a one-byte-corrupt invalid vector.
4. Generate a Node P-256 keypair and a WebAuthn-format assertion encoded the way that tag decodes it.
5. Check whether HybridDeleGator / DelegationManager / SimpleFactory exist on GIWA Sepolia by bytecode, not by name.
6. Because they do not, deploy only a probe that copies the verification libraries (no SCL fallback, no account, no DelegationManager).
7. Control: identical `eth_call`, one byte of `s` flipped.
8. Report gas for the raw precompile, the Solidity P-256 wrapper, and the WebAuthn HybridDeleGator branch.

Scripts: `scripts/p256-giwa-measure.js`, `scripts/p256-giwa-e2e.js`, `scripts/p256-probe-check.js`.
Probe source: `scripts/p256-probe/src/HybridP256Probe.sol` (solc 0.8.23, optimizer 200, via_ir).

---

## 2. Pinned release

Repo: https://github.com/MetaMask/delegation-framework

Tagged GitHub releases on that repo: `v1.0.0`, `v1.1.0`, `v1.2.0`, `v1.3.0`. **`v1.3.0` is the latest.**

| Field | Value |
| --- | --- |
| Tag | `v1.3.0` |
| Commit | `bfbdf9795a976833ed2fa000baf42fbb83958b03` |
| Created | 2025-07-21T13:17:12Z |
| Published | 2025-07-24T17:12:13Z |
| Contract `VERSION` | `"1.3.0"` in `src/HybridDeleGator.sol` |

README of that tag:

> We use tags for audited versions of code releases and the `main` branch is the working development branch.

Nothing below was read from `main`.

Audit artifacts shipped in the tag (not inferred from a blog post):

```
audits/diligence/diligence-6-24.pdf
audits/diligence/diligence-8-24.pdf
audits/diligence/diligence-9-24.pdf
audits/diligence/diligence-2-25.pdf
audits/diligence/diligence-4-25.pdf
audits/cyfrin/cyfrin-3-25.pdf
audits/cyfrin/cyfrin-4-25.pdf
audits/cyfrin/cyfrin-5-25-part1.pdf
audits/cyfrin/cyfrin-5-25-part2.pdf
```

Release notes for the tag include "Add Diligence and Cyfrin Audits" (PR 83) and "Add New Diligence And Cyfrin Audits May 2025" (PR 105). PDF interiors were not parsed. Dates in the filenames are the published labels.

v1.3.0 changelog also records the crypto switch that still holds in this tag: v1.2.0 replaced Fresh Crypto Lib (FCL) with SmoothCryptoLib (SCL). The fallback in v1.3.0 is SCL, not FCL, not daimo-eth `p256-verifier`.

Canonical CREATE2 addresses from `documents/Deployments.md` at the tag (salt `"GATOR"`):

```
SimpleFactory:          0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c
DelegationManager:      0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3
HybridDeleGatorImpl:    0x48dBe696A4D990079e039489bA2053B36E8FFEC4
```

GIWA / chain 91342 is not in that file's chain list.

---

## 3. Verification path in v1.3.0

Call chain for a WebAuthn P-256 signature:

```
HybridDeleGator._isValidSignature(bytes32 _hash, bytes calldata _signature)
  src/HybridDeleGator.sol

  if length == 65: ECDSA recover vs EOA owner
  if length < 96:  return SIG_VALIDATION_FAILED (0xffffffff)
  else:
    keyIdHash = first 32 bytes
    lookup authorizedKeys[keyIdHash]  (storage; x,y)
    if (x,y) == (0,0): SIG_VALIDATION_FAILED
    if length == 96:  P256VerifierLib._verifyRawP256Signature
    else:             P256VerifierLib._verifyWebAuthnP256Signature
```

```
P256VerifierLib._verifyWebAuthnP256Signature
  src/libraries/P256VerifierLib.sol
  decode, then WebAuthn.verifySignature
    challenge = abi.encodePacked(_hash)   // NOT taken from the signature
```

```
WebAuthn.verifySignature
  src/libraries/WebAuthn.sol
  - authenticatorData length >= 37
  - flags: UP required; UV if requireUserVerification; BE/BS consistency
  - clientDataJSON = prefix || Base64URL.encode(challenge) || suffix
  - contains('"type":"webauthn.get"', clientDataJSON, responseTypeLocation)
  - messageHash = sha256(authenticatorData || sha256(clientDataJSON))
  - P256SCLVerifierLib.verifySignature(messageHash, r, s, x, y)
```

```
P256SCLVerifierLib.verifySignature
  src/libraries/P256SCLVerifierLib.sol
  - reject s > n/2
  - staticcall address(0x100) with abi.encode(message_hash, r, s, x, y)
  - if success AND ret.length > 0 AND uint256(ret) == 1: return true
  - else: SCL_RIP7212.verify(...)   // SmoothCryptoLib, https://github.com/get-smooth/crypto-lib
```

Decision rule, quoted from the tag:

> staticcall returns true when the precompile does not exist but the ret.length is 0.

So "the call did not revert" is not a pass. Empty returndata is treated as "precompile missing" and the SCL fallback runs. A real precompile that rejects a signature also returns empty returndata, and then SCL runs a second time. That is why the comment says an invalid signature is validated twice.

This is not daimo-eth p256-verifier. `P256VerifierLib` still comments "wraps Daimo's Progressive Precompile P256 Verifier". That comment is stale. The Solidity imports `@SCL/lib/libSCL_RIP7212.sol`.

Stale comment also on encoding. `_isValidSignature` natspec still lists `challenge` and `challengeLocation` inside the signature. The decoder does not. Source of truth is `_decodeWebAuthnP256Signature`:

```
abi.decode(_signature, (
  bytes32,  // keyIdHash, ignored after the 32-byte prefix lookup
  uint256,  // r
  uint256,  // s
  bytes,    // authenticatorData
  bool,     // requireUserVerification
  string,   // clientDataJSONPrefix
  string,   // clientDataJSONSuffix
  uint256   // responseTypeLocation
))
```

Challenge is `_hash` packed as bytes, then base64url-inserted between prefix and suffix. Typical ceremony:

```
prefix  = '{"type":"webauthn.get","challenge":"'
suffix  = '","origin":"https://flizy.app","crossOrigin":false}'
responseTypeLocation = 1   // '"type":"webauthn.get"' starts at byte 1
```

Raw P256 (length 96) is a different branch: `sha256(abi.encodePacked(_hash))` then the same `P256SCLVerifierLib.verifySignature`. This experiment used the WebAuthn branch.

On a failed WebAuthn signature HybridDeleGator does **not revert**. It returns `ERC1271Lib.SIG_VALIDATION_FAILED` (`0xffffffff`). A revert on the control would have been the wrong kind of failure.

---

## 4. Raw responses: precompile at 0x100

`eth_getCode` of `0x0000000000000000000000000000000000000100`:

```
{"jsonrpc":"2.0","result":"0x","id":1}
```

Empty code is normal for a precompile. It is not evidence either way.

Known-valid vector: EIP-7951 test-vectors.json first entry, Wycheproof `ecdsa_secp256r1_sha256_p1363_test.json` SHA-256 #1. Spec expected output `0x00..01`.

`eth_call` valid:

```
{"jsonrpc":"2.0","result":"0x0000000000000000000000000000000000000000000000000000000000000001","id":1}
```

`debug_traceCall` valid (`callTracer`):

```
gasUsed: "0x76e4"          // 30436
output:  "0x0000000000000000000000000000000000000000000000000000000000000001"
to:      "0x0000000000000000000000000000000000000100"
```

`eth_estimateGas` valid: `"0x7843"` (30787).

Invalid vector: same 160 bytes with the first byte of `r` flipped `2b` -> `3b`.

`eth_call` invalid:

```
{"jsonrpc":"2.0","result":"0x","id":1}
```

`debug_traceCall` invalid:

```
gasUsed: "0x76e4"          // 30436, same as valid
to:      "0x0000000000000000000000000000000000000100"
```

No `output` field (empty returndata). Valid and invalid **differ**. This is not the missing-precompile trap (that trap returns success + empty for both).

EIP-7951 says a correct precompile MUST NOT revert, MUST return 32-byte `1` on success and empty on failure, and MUST consume the same gas either way. Observed behavior matches that. Spec gas is 6900 (EIP-7951) or 3450 (RIP-7212). Observed `gasUsed` on the top-level call is 30436. That number is the measured cost of calling `0x100` from the tracer, not a claim that GIWA's scheduled precompile gas is 30436. See section 7.

Same precompile also verified the Node-generated WebAuthn message hash (section 5): valid `0x00..01`, one-byte-corrupt `s` -> `0x`.

---

## 5. Real WebAuthn-format assertion

Generated in Node (`crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })`). Not a browser authenticator. Format follows WebAuthn-2 assertion hashing and the v1.3.0 decoder.

Ceremony used on the probe run (`scripts/p256-giwa-e2e.js`):

- `rpIdHash` = sha256(`flizy.app`)
- flags `0x05` (UP + UV)
- counter `1`
- `clientDataJSON` =
  `{"type":"webauthn.get","challenge":"wFwVEMp1cmEYOgg4_YU98HjgGm_ekgwYK-n_B_Cnapc","origin":"https://flizy.app","crossOrigin":false}`
- signed preimage = `authenticatorData || sha256(clientDataJSON)`
- IEEE-P1363 signature, `s` reduced to low-S (`s <= n/2` was true)
- ABI encoding: `(keyIdHash, r, s, authenticatorData, true, prefix, suffix, 1)`

That is a genuine P-256 signature over the WebAuthn message hash, not a hand-picked easy vector.

A second independent assertion was built in `scripts/p256-giwa-measure.js` and checked only at `0x100` (not through the probe). Valid returned `0x00..01`; corrupt `s` returned `0x`.

---

## 6. What is on GIWA Sepolia

`eth_getCode` of the v1.3.0 canonical addresses:

| Name | Address | Bytecode bytes |
| --- | --- | --- |
| HybridDeleGatorImpl | `0x48dBe696A4D990079e039489bA2053B36E8FFEC4` | 0 |
| DelegationManager | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` | 0 |
| SimpleFactory | `0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c` | 0 |

No HybridDeleGator, no DelegationManager, no factory. Bytecode match against the audited release is therefore not applicable: there is nothing to match.

Deployed for this test only, GIWA Sepolia, from the ops key:

| | |
| --- | --- |
| Contract | `HybridP256Probe` |
| Address | `0x3c490e8D049f14d7Ee51dc2cC6Ca7B5EB3418F19` |
| Deploy tx | `0x1822ce08999497f8d10bf5f0c4536b91831013cea12275b2322f9cb8f55e61e9` |
| From | `0x81Fb7Ed21B9843D2D5C232A7F3e959F91993401B` (ops) |
| Block | 34262923 |
| Receipt status | 1 |
| Deploy gas | 601452 |
| Runtime bytecode | 2536 bytes, matches local `scripts/p256-probe/out/HybridP256Probe.sol/HybridP256Probe.json` |

Why this and not HybridDeleGatorImpl: the question is signature verification, and the instruction was not to create user accounts or build a delegation. The probe copies `WebAuthn.verifySignature` and `P256SCLVerifierLib.verifySignature` from the tag, with two deliberate cuts:

1. No `SCL_RIP7212.verify` fallback. If `0x100` had been missing, this probe would return false on a valid signature. `0x100` is present, so the path taken is the same precompile path HybridDeleGator takes first.
2. `x,y` are calldata, not `authorizedKeys[keyIdHash]` storage. Cryptographic check is the same; key-id membership is not.

Nothing was deployed to any other chain.

---

## 7. Control A / B and gas

Probe `hybridWebAuthnBranch(hash, signature, x, y)` on GIWA Sepolia. Case B is Case A with `s XOR 1`. Same account, same ABI, same gas strategy.

| | Case A valid | Case B one-byte corrupt s |
| --- | --- | --- |
| `hybridWebAuthnBranch` | `true` | `false` |
| `eth_call` returndata | `0x0000...0001` | `0x0000...0000` |
| revert | no | no |
| `estimateGas` | 75473 | 75231 |
| `verifySignature` (P-256 wrapper only) | `true` | `false` |
| `verifySignature` `estimateGas` | 31774 | (not separately estimated this run) |

B did not revert. HybridDeleGator also does not revert on a bad P-256 / WebAuthn signature; it returns `SIG_VALIDATION_FAILED`. The probe returning `false` / `0x00..00` is that same signature-failure mode, not an ABI or gas error. An encoding mistake would have reverted both calls or reverted B with a panic / decode error. It did not.

If B had also returned `true`, the result would be void. It did not.

Gas, per signature, this run:

| Path | Number | How |
| --- | --- | --- |
| Raw `0x100` (Wycheproof #1) | **30436** | `debug_traceCall.gasUsed` = `0x76e4`. Valid and invalid identical. |
| Raw `0x100` estimate | 30787 | `eth_estimateGas` = `0x7843` |
| Solidity P-256 wrapper (`verifySignature` on the probe = precompile path of `P256SCLVerifierLib`, no SCL) | **31774** | `eth_estimateGas` |
| WebAuthn HybridDeleGator branch on the probe | **75473** | `eth_estimateGas` of `hybridWebAuthnBranch` |
| SCL fallback | not measured | path not taken; `0x100` succeeded |

The number that matters at scale for a WebAuthn passkey check through this library path is **75473 gas per signature**, as measured. That includes WebAuthn JSON reconstruction, two SHA-256, flag checks, ABI decode, and the `0x100` staticcall. It does not include HybridDeleGator storage lookup, ERC-1271 wrapping, UserOp validation, or a DelegationManager redeem.

Inference, not measured: EIP-7951 schedules 6900 gas for `P256VERIFY`; RIP-7212 scheduled 3450. The 30436 figure is the tracer's cost of a top-level CALL to `0x100` with 160 bytes of input, which includes more than the precompile's scheduled gas. Do not treat 30436 as GIWA's published precompile price. The 31774 wrapper figure is what a Solidity caller actually paid in `estimateGas`.

---

## 8. What is confirmed

- `v1.3.0` is the latest tagged, audited MetaMask delegation-framework release. Audits are in the tag.
- HybridDeleGator verifies WebAuthn P-256 by reconstructing `clientDataJSON`, hashing per WebAuthn-2, then `staticcall` `0x100`, then SCL if returndata is empty.
- On GIWA Sepolia, `0x100` is a real P-256 verifier: known-valid Wycheproof #1 returns 32-byte `1`; one-byte-corrupt `r` returns empty; gasUsed is the same.
- A Node-generated WebAuthn-format assertion verifies on that precompile and through the copied HybridDeleGator WebAuthn branch.
- The A/B control holds: valid true, corrupt false, no revert, ABI shape identical.
- Canonical HybridDeleGatorImpl / DelegationManager / SimpleFactory have no bytecode on GIWA Sepolia.
- SCL was not needed on this chain for this call.

---

## 9. What remains unverified

- **The HybridDeleGator contract itself.** Not deployed. ERC-1271 wrapping, `authorizedKeys` lookup, EOA-vs-P256 length dispatch inside `_isValidSignature`, UserOp validation, and DelegationManager were not executed.
- **SCL fallback.** Not entered. Gas for a missing-precompile path is unknown on this chain and irrelevant while `0x100` works.
- **Bytecode identity with HybridDeleGatorImpl.** The probe is a copy of the libraries, compiled here with solc 0.8.23 / optimizer 200 / via_ir. It is not a bytecode match against MetaMask's deployed HybridDeleGatorImpl on other chains.
- **Hardware / browser WebAuthn.** Assertion was Node `crypto.sign` over a constructed `authenticatorData` and `clientDataJSON`. Format and curve are real. A platform authenticator was not in the loop.
- **On-chain inclusion cost.** All verification calls were `eth_call` / `estimateGas` / `debug_traceCall`. No UserOp. No bundled tx that pays these 75473 gas as verification gas inside ERC-4337.
- **GIWA's exact precompile gas schedule.** Observed 30436 / 30787 / 31774. Spec 3450 or 6900. The schedule register was not read from a client source.

---

## 10. Inferences (labeled)

- Inference: GIWA implements RIP-7212 / EIP-7951 `P256VERIFY` at `0x100`. Supported by valid vs invalid vectors matching the spec outputs. Not supported by "OP Stack", "reth", "code at 0x100", or docs.
- Inference: a production HybridDeleGator on this chain would take the precompile path, not SCL, for a well-formed signature. Supported by `ret.length > 0` and `uint256(ret) == 1` on valid calls. Not proven by deploying HybridDeleGatorImpl.
- Inference: 75473 gas is a fair per-signature number for the WebAuthn library path. Not a UserOp total and not a DelegationManager redeem.
