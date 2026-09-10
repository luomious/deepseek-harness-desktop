// 临时冒烟测试：验证 code-security-guard 规则能命中危险模式、不误报安全模式
const DEFAULT_RULES = [
  { re: /\bos\.system\s*\(/i, reason: 'os.system() 命令执行' },
  { re: /\bos\.popen\s*\(/i, reason: 'os.popen() 命令执行' },
  { re: /\bsubprocess\.(?:call|run|Popen|check_output|check_call)\s*\([^)]*shell\s*=\s*True/i, reason: 'subprocess shell=True' },
  { re: /\bpickle\.(?:load|loads)\s*\(/i, reason: 'pickle 反序列化' },
  { re: /\byaml\.load\s*\(/i, reason: 'yaml.load 不安全' },
  { re: /\beval\s*\(/i, reason: 'eval 动态执行' },
  { re: /\bexec\s*\(/i, reason: 'exec 动态执行' },
  { re: /\bdangerouslySetInnerHTML/i, reason: 'XSS' },
  { re: /\binnerHTML\s*[+=]/i, reason: 'innerHTML XSS' },
  { re: /\bdocument\.write\s*\(/i, reason: 'document.write XSS' },
  { re: /verify\s*=\s*False/i, reason: 'TLS 关闭' },
  { re: /\bnew\s+Function\s*\(/i, reason: 'new Function RCE' },
];

function scan(text) {
  const hits = [];
  for (const r of DEFAULT_RULES) {
    if (r.re.test(text)) hits.push(r.reason);
  }
  return hits;
}

const dangerous = [
  'import os; os.system("rm -rf /")',
  'result = eval(user_input)',
  'data = pickle.loads(blob)',
  'requests.get(url, verify=False)',
  'return <div dangerouslySetInnerHTML={{__html: html}} />',
  'subprocess.call(cmd, shell=True)',
  'el.innerHTML = userContent',
  'document.write(location.hash)',
  'new Function("return " + code)',
  'import yaml; cfg = yaml.load(f)',
  'os.popen("dir")',
  'exec(compiled_code)',
];

const safe = [
  'def evaluate(x): return x * 2',
  'const executor = new Executor(config)',
  'element.textContent = userContent',
  'json.loads(data)',
  'document.getElementById("app")',
  'executor.run()',
  'requests.get(url, verify=True)',
  'yaml.safe_load(f)',
  'innerText = userContent',
];

let hit = 0, miss = 0;
for (const t of dangerous) {
  const r = scan(t);
  if (r.length) { hit++; console.log('HIT  ', r.join(' | '), '<=', t.slice(0, 50)); }
  else { miss++; console.log('MISS!', t); }
}
let falsePos = 0;
for (const t of safe) {
  const r = scan(t);
  if (r.length) { falsePos++; console.log('FP!  ', r.join(' | '), '<=', t); }
  else { console.log('OK   ', t); }
}
console.log('---');
console.log(`dangerous hit: ${hit}/${dangerous.length} | safe falsePos: ${falsePos}/${safe.length}`);
process.exit(hit === dangerous.length && falsePos === 0 ? 0 : 1);
