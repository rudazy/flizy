/**
 * Read-only: eth_getCode of canonical v1.3.0 CREATE2 addresses on GIWA Sepolia.
 */
const RPC = 'https://sepolia-rpc.giwa.io';

const ADDRS = {
  SimpleFactory: '0x69Aa2f9fe1572F1B640E1bbc512f5c3a734fc77c',
  DelegationManager: '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3',
  HybridDeleGatorImpl: '0x48dBe696A4D990079e039489bA2053B36E8FFEC4',
  AllowedTargetsEnforcer: '0x7F20f61b1f09b08D970938F6fa563634d65c4EeB',
  AllowedCalldataEnforcer: '0xc2b0d624c1c4319760C96503BA27C347F3260f55',
  AllowedMethodsEnforcer: '0x2c21fD0Cb9DC8445CB3fb0DC5E7Bb0Aca01842B5',
};

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

async function main() {
  const chain = await rpc('eth_chainId', []);
  console.log('chainId', chain.result, 'decimal', parseInt(chain.result, 16));
  for (const [name, addr] of Object.entries(ADDRS)) {
    const code = await rpc('eth_getCode', [addr, 'latest']);
    const hex = String(code.result || '0x');
    const bytes = hex === '0x' || hex === '0x0' ? 0 : (hex.length - 2) / 2;
    console.log(name, addr, 'codeBytes', bytes);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
