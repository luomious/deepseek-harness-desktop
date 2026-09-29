import fs from 'node:fs';
import path from 'node:path';

const FILE = 'C:/Users/机械革命/AppData/Roaming/DSH Desktop/profile-selection/state.json';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const BK = `D:/Deepseek-Harness/_backups/profile-selection-pin-desktop-${STAMP}`;
const APPLY = process.argv.includes('--apply');

const cur = JSON.parse(fs.readFileSync(FILE, 'utf8'));
console.log('当前:', JSON.stringify(cur));

const next = {
  version: cur.version ?? 1,
  active: 'desktop',
  pending: 'desktop',
  lastKnownGood: 'desktop',
};

if (next.active === cur.active && next.lastKnownGood === cur.lastKnownGood && next.pending === cur.pending) {
  console.log('已经是 desktop 优先，无需改动');
  process.exit(0);
}

if (!APPLY) { console.log('将写入:', JSON.stringify(next)); console.log('DRY-RUN：加 --apply 写入'); process.exit(0); }

fs.mkdirSync(BK, { recursive: true });
fs.writeFileSync(path.join(BK, 'state.json.bak'), fs.readFileSync(FILE));
const tmp = FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
fs.renameSync(tmp, FILE);
const back = JSON.parse(fs.readFileSync(FILE, 'utf8'));
console.log('回读:', JSON.stringify(back));
console.log('备份:', BK);
