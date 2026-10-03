# Privy as HybridDeleGator owner on GIWA Sepolia

Verdict: **PASS**. Failed steps: none. Not covered: S9 and the browser login.

Chain 91342, explorer https://sepolia-explorer.giwa.io. MetaMask delegation-framework v1.3.0 (commit bfbdf97),
contracts from deployments/giwa-sepolia-delegation.json. Throwaway accounts and testnet amounts only.
Transaction hashes open at the explorer under /tx/<hash>. Generated from state.json by server/results.cjs.

## Coverage

Runner: headless: Node calls the Privy wallet API; no browser.
Privy wallet: Privy server wallet created through POST /v1/wallets, owned by a locally generated P-256 authorization key.

**Not covered by this run:**

- Browser login (email) and the Privy embedded-wallet signing UI
- S9: guest MetaMask wallet connected through Privy doing a self-transfer

## Accounts

- Gator: 0x3B89C8bA8D4B5DbeEA2b3E92aa619b6A277268Df
- Original owner (throwaway EOA): 0x8E22cB0962578a88514e3518eaaF7a473915A46D
- Privy wallet (new owner): 0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6 (privy-server-wallet)
- Flizy stand-in delegate: 0x5bf9D5C71913233AdE339C2D34674c1f0F6cc2A2
- Relayer and funder: 0x046468b2400a799d5897cDfbB4d1782E6B8EC788
- Sink: 0x46BB832b0d0BE221dF417Eaf07B75bf042A0D6A4
- ERC20TransferAmountEnforcer (deployed for this spike): 0xDBF11aC916D43C589D237599E0DBbA1F60d84ac4

## Steps

| Step | What | Result |
| --- | --- | --- |
| S1 | Privy wallet signs a message and an EIP-712 payload | PASS |
| S2 | Throwaway gator owned by a throwaway EOA, funded with ETH and FLZ | PASS |
| S3 | Ownership moves to the Privy wallet; the old owner signature is rejected | PASS |
| S4 | Privy wallet signs the delegations; ERC-1271 returns the magic value | PASS |
| S5 | Redemption: in-bounds ETH, out-of-bounds ETH, FLZ | PASS |
| S6 | Revoke | PASS |
| S7 | Owner exit | PASS |
| S8 | Gator address stable throughout | PASS |
| S9 | Guest MetaMask wallet through Privy does a self-transfer | not covered |

### S1: Privy wallet signs a message and an EIP-712 payload

Status: PASS, at 2026-10-03T12:42:24.545Z.

```json
{
  "status": "PASS",
  "at": "2026-10-03T12:42:24.545Z",
  "address": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6",
  "recoveredMessage": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6",
  "recoveredTyped": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6",
  "walletClientType": "privy-server-wallet"
}
```

### S2: Throwaway gator owned by a throwaway EOA, funded with ETH and FLZ

Status: PASS, at 2026-10-03T08:58:22.905Z.

```json
{
  "status": "PASS",
  "at": "2026-10-03T08:58:22.905Z",
  "gator": "0x3B89C8bA8D4B5DbeEA2b3E92aa619b6A277268Df",
  "owner": "0x8E22cB0962578a88514e3518eaaF7a473915A46D",
  "codeKeccak": "0xeea896c7b0a3442ea3a79a89e5109ac4e63728ec288722197f6391cd6112aa74",
  "gatorEth": "20000000000000000",
  "gatorFlz": "20000000000000000000",
  "erc20Enforcer": {
    "address": "0xDBF11aC916D43C589D237599E0DBbA1F60d84ac4",
    "tx": "0x1b8a531579aaee38fc89b3724eb8a2c6cef23209a3457fd214f6409958b57bba",
    "runtimeMatchesArtifact": true
  },
  "deployTx": "0x6ce05c8d5ab03d27f237b062a8e730581ca71d3ecd86f87e791f64f4541ce780",
  "funding": {
    "gatorEth": "0xbaa83e3c45df2cfa5e6560eb38d48c2b160ece024879af4c57e787c3106466cf",
    "gatorFlz": "0xe52297ce2b05476030f4bc85c3c93cf3a38d263cbfea925934fc935e0d5fe626",
    "delegateEth": "0xf3149df2f4284cb9357ae0609af9985f6bffe329c002491636f7d38d3abd6f74"
  }
}
```

### S3: Ownership moves to the Privy wallet; the old owner signature is rejected

Status: PASS, at 2026-10-03T12:42:40.773Z.

```json
{
  "status": "PASS",
  "at": "2026-10-03T12:42:40.773Z",
  "transferTx": "0x444cb764cbeaecc583ef69c60a7f5e4058d8e9e614b9ddd11d34e707a5d35c39",
  "userOpSuccess": true,
  "ownerBefore": "0x8E22cB0962578a88514e3518eaaF7a473915A46D",
  "ownerAfter": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6",
  "addressUnchanged": true,
  "codeUnchanged": true,
  "oldDelegationDigest": "0x3346301592f0b1833f16f553b104caf586156fcdf969882e6d83a5a0db15a910",
  "oldOwnerDelegationMagicBefore": "0x1626ba7e",
  "oldDelegationRedeemBefore": "would succeed",
  "oldOwnerDelegationMagicAfter": "0xffffffff",
  "oldDelegationRedeemAfter": "InvalidERC1271Signature()",
  "oldOwnerUserOpMagicAfter": "0xffffffff"
}
```

### S4: Privy wallet signs the delegations; ERC-1271 returns the magic value

Status: PASS, at 2026-10-03T12:42:47.432Z.

```json
{
  "status": "PASS",
  "at": "2026-10-03T12:42:47.432Z",
  "signer": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6",
  "eth": {
    "digest": "0x6785f3a221014314a3f2f3ea641f16dc24d886c7c1c2fa0cba0a551f30498318",
    "recovered": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6",
    "magic": "0x1626ba7e"
  },
  "flz": {
    "digest": "0x11aa00ae5d85b1826c4dba2eaca8759c997ed4582c955b91a35fb81459c77e94",
    "recovered": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6",
    "magic": "0x1626ba7e"
  },
  "caveats": {
    "eth": "NativeTokenTransferAmount cap 0.005 ETH, Timestamp before now+1d, AllowedTargets [sink]",
    "flz": "ERC20TransferAmount FLZ cap 10, NativeTokenTransferAmount cap 0, Timestamp before now+1d, AllowedTargets [FLZ]"
  }
}
```

### S5: Redemption: in-bounds ETH, out-of-bounds ETH, FLZ

Status: PASS, at 2026-10-03T12:43:05.421Z.

```json
{
  "status": "PASS",
  "at": "2026-10-03T12:43:05.421Z",
  "a_ethInBounds": {
    "ok": true,
    "amount": "0.001 ETH",
    "tx": "0x7d09b3f5ea5e2c3eb01d9830eb4ac5a8b84ebce70864f164fa0ef8266682b314",
    "block": 37686256,
    "status": 1,
    "gasUsed": "193275",
    "delta": {
      "gator": {
        "eth": "-1000000000000000",
        "flz": "0"
      },
      "sink": {
        "eth": "1000000000000000",
        "flz": "0"
      }
    }
  },
  "b_ethOutOfBounds": {
    "ok": true,
    "amount": "0.01 ETH",
    "revert": {
      "raw": "0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000344e6174697665546f6b656e5472616e73666572416d6f756e74456e666f726365723a616c6c6f77616e63652d6578636565646564000000000000000000000000",
      "selector": "0x08c379a0",
      "text": "NativeTokenTransferAmountEnforcer:allowance-exceeded"
    }
  },
  "c_flzInBounds": {
    "ok": true,
    "amount": "1 FLZ",
    "tx": "0xfd3390446bba1ea3aaf665bbe85b3481cac3eda5add8cf7d67609465338641b7",
    "block": 37686265,
    "status": 1,
    "gasUsed": "221859",
    "delta": {
      "gator": {
        "eth": "0",
        "flz": "-1000000000000000000"
      },
      "sink": {
        "eth": "0",
        "flz": "1000000000000000000"
      }
    }
  },
  "c_flzOutOfBounds": {
    "ok": true,
    "amount": "20 FLZ",
    "revert": {
      "raw": "0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002e45524332305472616e73666572416d6f756e74456e666f726365723a616c6c6f77616e63652d6578636565646564000000000000000000000000000000000000",
      "selector": "0x08c379a0",
      "text": "ERC20TransferAmountEnforcer:allowance-exceeded"
    }
  }
}
```

### S6: Revoke

Status: PASS, at 2026-10-03T12:43:14.005Z.

```json
{
  "status": "PASS",
  "at": "2026-10-03T12:43:14.005Z",
  "signer": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6",
  "userOpSignatureMagic": "0x1626ba7e",
  "disableTx": "0x37b2de84ad2baa9cbfdf096547829045c88fea31e8d2acd512f154a08803fc08",
  "userOpSuccess": true,
  "delegationDigest": "0x6785f3a221014314a3f2f3ea641f16dc24d886c7c1c2fa0cba0a551f30498318",
  "disabled": true,
  "inBoundsReplay": "CannotUseADisabledDelegation()"
}
```

### S7: Owner exit

Status: PASS, at 2026-10-03T12:43:25.798Z.

```json
{
  "status": "PASS",
  "at": "2026-10-03T12:43:25.798Z",
  "signer": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6",
  "userOpSignatureMagic": "0x1626ba7e",
  "exitTx": "0x840f61bf07f5b23c389f92813dd2f608ab1d26104d845f2d80a92d33ff7fce55",
  "userOpSuccess": true,
  "revertReason": null,
  "path": "Privy-signed PackedUserOperation, EntryPoint v0.7 handleOps sent directly by an EOA relayer, no bundler",
  "exitEth": "0.01 ETH (twice the delegation cap)",
  "exitFlz": "5 FLZ",
  "privyEthDelta": "10000000000000000",
  "privyFlzDelta": "5000000000000000000",
  "exitBlock": 37686286,
  "gatorEthDelta": "-10000219297402544",
  "gatorFlzDelta": "-5000000000000000000"
}
```

### S8: Gator address stable throughout

Status: PASS, at 2026-10-03T12:43:27.782Z.

```json
{
  "status": "PASS",
  "at": "2026-10-03T12:43:27.782Z",
  "address": "0x3B89C8bA8D4B5DbeEA2b3E92aa619b6A277268Df",
  "codeKeccak": "0xeea896c7b0a3442ea3a79a89e5109ac4e63728ec288722197f6391cd6112aa74",
  "snapshots": [
    {
      "label": "after S2 deploy",
      "block": 37672785,
      "owner": "0x8E22cB0962578a88514e3518eaaF7a473915A46D",
      "sameCode": true
    },
    {
      "label": "before S3 transfer",
      "block": 37686231,
      "owner": "0x8E22cB0962578a88514e3518eaaF7a473915A46D",
      "sameCode": true
    },
    {
      "label": "after S3 transfer",
      "block": 37686241,
      "owner": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6",
      "sameCode": true
    },
    {
      "label": "S8 final",
      "block": 37686291,
      "owner": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6",
      "sameCode": true
    }
  ],
  "finalOwner": "0xA1b2414Eb421397974ed9184cDeBb2216cA68Da6"
}
```
