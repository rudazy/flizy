const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = 'https://sepolia-rpc.giwa.io';
const PROBE = '0x3c490e8D049f14d7Ee51dc2cC6Ca7B5EB3418F19';
const DEPLOY_TX = '0x1822ce08999497f8d10bf5f0c4536b91831013cea12275b2322f9cb8f55e61e9';

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json();
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, 91342);
  const code = await provider.getCode(PROBE);
  const tx = await provider.getTransaction(DEPLOY_TX);
  const rec = await provider.getTransactionReceipt(DEPLOY_TX);

  const artifactPath = path.join(
    __dirname,
    'p256-probe',
    'out',
    'HybridP256Probe.sol',
    'HybridP256Probe.json'
  );
  let artifactDeployed = null;
  let bytecodeMatch = null;
  if (fs.existsSync(artifactPath)) {
    const art = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    artifactDeployed = art.deployedBytecode && art.deployedBytecode.object;
    if (artifactDeployed) {
      bytecodeMatch = code.toLowerCase() === artifactDeployed.toLowerCase();
    }
  }

  const invalidInput =
    '0xbb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023' +
    '3ba3a8be6b94d5ec80a6d9d1190a436effe50d85a1eee859b8cc6af9bd5c2e18' +
    '4cd60b855d442f5b3c7b11eb6c4e0ae7525fe710fab9aa7c77a67f79e6fadd76' +
    '2927b10512bae3eddcfe467828128bad2903269919f7086069c8c4df6c732838' +
    'c7787964eaac00e5921fb1498a60f4606766b3d9685001558d1a974e7341513e';
  const invalidCall = await rpc('eth_call', [
    { to: '0x0000000000000000000000000000000000000100', data: invalidInput },
    'latest',
  ]);
  const invalidTrace = await rpc('debug_traceCall', [
    { to: '0x0000000000000000000000000000000000000100', data: invalidInput },
    'latest',
    { tracer: 'callTracer' },
  ]);

  console.log(
    JSON.stringify(
      {
        probe: PROBE,
        probeCodeBytes: code === '0x' ? 0 : (code.length - 2) / 2,
        probeCodeHead: code.slice(0, 42),
        bytecodeMatch,
        artifactPresent: Boolean(artifactDeployed),
        txFrom: tx && tx.from,
        txTo: tx && tx.to,
        recStatus: rec && rec.status,
        recContract: rec && rec.contractAddress,
        recBlock: rec && Number(rec.blockNumber),
        recGas: rec && rec.gasUsed.toString(),
        invalidCall,
        invalidTrace,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
