#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT = path.join(ROOT, 'contracts', 'DreamDexVolumeBatch7702.sol');
const OUT_DIR = path.join(ROOT, 'artifacts', 'solc-out');
const OUT_FILE = path.join(ROOT, 'artifacts', 'delegation', 'DreamDexVolumeBatch7702.json');

function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  execSync(
    [
      'npx',
      '--yes',
      'solc@0.8.20',
      '--optimize',
      '--bin',
      '--abi',
      `--base-path "${ROOT}"`,
      `-o "${OUT_DIR}"`,
      `"${CONTRACT}"`,
    ].join(' '),
    { cwd: ROOT, encoding: 'utf8', shell: true, stdio: 'pipe' }
  );

  const binPath = path.join(
    OUT_DIR,
    'contracts_DreamDexVolumeBatch7702_sol_DreamDexVolumeBatch7702.bin'
  );
  const abiPath = path.join(
    OUT_DIR,
    'contracts_DreamDexVolumeBatch7702_sol_DreamDexVolumeBatch7702.abi'
  );

  if (!fs.existsSync(binPath) || !fs.existsSync(abiPath)) {
    const files = fs.readdirSync(OUT_DIR);
    throw new Error(`Unexpected solc output files: ${files.join(', ')}`);
  }

  const artifact = {
    contractName: 'DreamDexVolumeBatch7702',
    sourceName: 'contracts/DreamDexVolumeBatch7702.sol',
    abi: JSON.parse(fs.readFileSync(abiPath, 'utf8')),
    bytecode: `0x${fs.readFileSync(binPath, 'utf8').trim()}`,
    compiledAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`Bytecode bytes: ${(artifact.bytecode.length - 2) / 2}`);
}

main();
