/* 测试用的临时环境：复制一份真实数据到临时目录，起一个独立的服务，测完删掉。
    这样测试建的账号、写的跟进记录不会落到真实数据里。
    用法：const env = await require('./env').start(); … await env.stop(); */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..', '..');          // 仓库根目录
const DATA = path.join(ROOT, 'data', 'crm');                 // 真实数据在这里（只用来复制一份）
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
  const data = path.join(dir, 'data');                       // 报价系统的数据目录
  const crmData = path.join(data, 'crm');                    // 客户跟进的数据在它下面
  fs.mkdirSync(crmData, { recursive: true });
  for (const f of ['customers.json', 'orders.json', 'meta.json', 'settings.json']) {
    const src = path.join(DATA, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(crmData, f));
  }
  const port = Number(process.env.CRM_TEST_PORT) || 6700 + Math.floor(Math.random() * 200);   // 可用环境变量固定端口，方便排查
  /* 设了 CRM_TEST_TRACE 时，记录服务端每个连接的建立/关闭/错误（排查连接问题用） */
  const args = [];
  if (process.env.CRM_TEST_TRACE) {
    const pre = path.join(dir, 'trace.js');
    fs.writeFileSync(pre, `const http = require('http'); const t0 = Date.now(); const orig = http.createServer.bind(http); const ms = () => (Date.now() - t0 + 'ms').padStart(7);
      http.createServer = function (...a) { const s = orig(...a);
        s.on('connection', c => { c.__id = Math.random().toString(36).slice(2, 6); console.error(ms(), '[conn +]', c.__id);
          c.on('close', () => console.error(ms(), '[conn -]', c.__id, 'read=' + c.bytesRead, 'wrote=' + c.bytesWritten)); c.on('error', e => console.error(ms(), '[conn err]', c.__id, e.code)); });
        s.on('clientError', (e, c) => console.error(ms(), '[clientError]', e.code, e.message)); return s; };`);
    args.push('-r', pre);
  }
  args.push(path.join(ROOT, 'server', 'server.js'));          // 合并后只有一个服务：报价 + 客户跟进
  /* 服务输出写进临时目录里的 server.log，排查时看 */
  const logFile = path.join(dir, 'server.log');
  const log = fs.createWriteStream(logFile);
  const child = spawn(process.execPath, args,
    { env: Object.assign({}, process.env, { PORT: String(port), DATA: data }), stdio: ['ignore', 'pipe', 'pipe'] });   // 服务崩了能看到原因
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let exited = false, stopping = false, exitInfo = null;
  child.on('exit', (code, sig) => {
    exited = true; exitInfo = { code, sig };
    if (!stopping) console.error('!! 测试服务意外退出：code=' + code + ' signal=' + sig);
  });
  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    if (exited) break;
    try { up = (await fetch(base + '/healthz')).status === 200; } catch (e) { /* 还没起来 */ }
    if (!up) await sleep(250);
  }
  if (!up) { child.kill(); throw new Error('测试服务没起来（端口 ' + port + (exited ? '，进程已退出' : '，超时') + '）'); }
  return {
    base, data,
    alive: () => !exited,
    /* 退出码 + 服务日志的最后几行（日志经管道落盘会慢半拍，先等一下） */
    async report() {
      await sleep(800);
      let tail = '';
      try { tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-12).join('\n'); } catch (e) { /* 没有日志 */ }
      return 'exit=' + JSON.stringify(exitInfo) + '\n--- server.log 末尾 ---\n' + (tail || '（空）');
    },
    async stop() {
      stopping = true;
      child.kill();
      await sleep(300);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 临时目录留着也无妨 */ }
    }
  };
}
module.exports = { start };
