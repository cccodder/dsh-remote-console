/**
 * 工具层集成测试：真实 sshd + 假 DSH 服务，直接调用注册出来的工具定义（execute），
 * 覆盖 remote_exec / 传输 / 端口转发，并确认审计日志真的落盘、且不含命令输出内容。
 *
 * 没有 ssh/sshd 时整组跳过（与 integration-sshd.test.mjs 同一套 harness）。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { startSshd, waitFor, waitForPortClosed } from './sshd-harness.mjs';

const state = {};

/** 粗判机器上有没有 ssh/sshd；真找不到时 startSshd 也会抛错，整组跳过。 */
function hasTool(envName, bin) {
  const explicit = process.env[envName];
  const result = spawnSync(explicit ?? bin, ['-V'], { encoding: 'utf8' });
  return result.error === undefined || result.status === 0;
}
const MISSING = [
  hasTool('SSH_BIN', 'ssh') ? undefined : 'ssh',
  hasTool('SSHD_BIN', 'sshd') ? undefined : 'sshd',
].filter((entry) => entry !== undefined);

function makeCtx() {
  const registered = new Map();
  const tools = {
    register(definition) {
      registered.set(definition.name, definition);
      return () => {};
    },
  };
  const controller = {
    shells: async () => [],
    list: () => [],
    retain: () => ({ type: 'retained' }),
  };
  const ctx = {
    subprocess: {
      spawnTerminal: async () => {
        throw new Error('spawnTerminal is not used in this test');
      },
    },
    terminalController: controller,
    get(service) {
      return service === 'tools' ? tools : undefined;
    },
    effect(fn) {
      const disposer = fn();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    on() {},
    logger: { info() {}, warn() {}, debug() {}, error() {} },
  };
  return { ctx, registered };
}

describe('工具层 + 审计（真实 sshd）', { skip: MISSING.length > 0 ? `no ${MISSING.join('/')} available` : false }, () => {
  let rcDir;
  let h;
  let plugin;
  let registered;
  let dispose;
  let sock;

  before(async () => {
    h = await startSshd();
    rcDir = mkdtempSync(join(tmpdir(), 'dsh-rc-tools-'));
    process.env.DSH_REMOTE_CONSOLE_DIR = rcDir;
    process.env.DSH_SSH_CONFIG = h.sshConfigPath;
    process.env.DSH_RC_NO_CLEAR = '1';
    plugin = await import('../lib/index.js');
    const { ctx, registered: defs } = makeCtx();
    registered = defs;
    dispose = plugin.apply(ctx);
    // 起一个真正的 ControlMaster（不是包装器，避免依赖 PTY），再把 cover 放进插件状态
    sock = join(rcDir, 'tools.sock');
    const master = spawnSync(
      h.sshBin,
      ['-F', h.sshConfigPath, '-M', '-S', sock, '-N', '-f', h.hostAlias],
      { env: h.childEnv, encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(master.status, 0, master.stderr);
    await waitFor(
      () =>
        spawnSync(h.sshBin, ['-F', h.sshConfigPath, '-S', sock, '-O', 'check', h.hostAlias], { env: h.childEnv }).status === 0,
      {
        timeout: 10000,
        message: 'ControlMaster 没有就绪',
      },
    );
    // writeEvent / audit 需要一个像 Console 的对象：给足事件数组与日志路径
    const cover = {
      pid: 'tools-1',
      host: h.hostAlias,
      socket: sock,
      ended: false,
      pending: null,
      events: [],
      logPath: join(rcDir, 'cover.jsonl'),
    };
    plugin.__testing.state().consoles.set(cover.pid, cover);
    state.cover = cover;
  });

  after(async () => {
    if (sock !== undefined && h !== undefined) {
      spawnSync(h.sshBin, ['-F', h.sshConfigPath, '-S', sock, '-O', 'exit', h.hostAlias], { env: h.childEnv });
    }
    if (typeof dispose === 'function') dispose();
    if (h !== undefined) await h.stop();
  });

  const exec = { agent: undefined };

  it('remote_exec 走真实通道并返回退出码', async () => {
    const tool = registered.get('remote_exec');
    assert.ok(tool, 'remote_exec 应已注册');
    const result = await tool.execute({ command: 'printf "TOOLS-OK\\n"' }, exec);
    assert.match(result.text, /status: done/u);
    assert.match(result.text, /exit_code: 0/u);
    assert.match(result.text, /TOOLS-OK/u);
  });

  it('remote_upload / remote_download 真传文件并双向校验', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-rc-tools-files-'));
    const localPath = join(dir, 'payload.bin');
    const payload = Buffer.alloc(64 * 1024);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    writeFileSync(localPath, payload);
    const expected = createHash('sha256').update(payload).digest('hex');

    const uploaded = await registered.get('remote_upload').execute(
      { local_path: localPath, remote_path: `${dir}/remote-payload.bin` },
      exec,
    );
    assert.match(uploaded.text, /verified: yes/u);
    assert.match(uploaded.text, new RegExp(expected, 'u'));

    const downloadedPath = join(dir, 'downloaded.bin');
    const downloaded = await registered.get('remote_download').execute(
      { remote_path: `${dir}/remote-payload.bin`, local_path: downloadedPath },
      exec,
    );
    assert.match(downloaded.text, /verified: yes/u);
    assert.equal(createHash('sha256').update(readFileSync(downloadedPath)).digest('hex'), expected);

    // 默认不覆盖
    await assert.rejects(
      () => registered.get('remote_download').execute({ remote_path: `${dir}/remote-payload.bin`, local_path: downloadedPath }, exec),
      /FILE_EXISTS/u,
    );
  });

  it('单文件传输上限可配：默认 256 MB，调到 1 MB 后按新上限拒绝', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-rc-tools-limit-'));
    const localPath = join(dir, 'big.bin');
    writeFileSync(localPath, Buffer.alloc(1024 * 1024 + 1));

    const shared = plugin.__testing.state();
    const original = shared.config;
    try {
      shared.config = { ...original, maxTransferMB: 1 };
      await assert.rejects(
        () => registered.get('remote_upload').execute({ local_path: localPath, remote_path: `${dir}/uploaded-big.bin` }, exec),
        (error) => {
          assert.match(String(error.message), /FILE_TOO_LARGE/u);
          assert.match(String(error.message), /1 MB/u);
          // 报错要告诉用户去哪改，否则只看到一个数字
          assert.match(String(error.message), /maxTransferMB|DSH_RC_MAX_TRANSFER_MB/u);
          return true;
        },
      );
    } finally {
      shared.config = original;
    }

    // 恢复默认上限后同一个文件可以传（上限逻辑没有把状态写死）
    const uploaded = await registered.get('remote_upload').execute(
      { local_path: localPath, remote_path: `${dir}/uploaded-big.bin` },
      exec,
    );
    assert.match(uploaded.text, /verified: yes/u);
  });

  it('remote_read_file / remote_write_file 往返一致', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-rc-tools-text-'));
    const remotePath = `${dir}/note.txt`;
    const written = await registered.get('remote_write_file').execute({ path: remotePath, content: 'alpha\n' }, exec);
    assert.match(written.text, /status: done/u);
    await registered.get('remote_write_file').execute({ path: remotePath, content: 'beta\n', append: true }, exec);
    const read = await registered.get('remote_read_file').execute({ path: remotePath }, exec);
    assert.match(read.text, /alpha/u);
    assert.match(read.text, /beta/u);
    // 路径安全
    await assert.rejects(
      () => registered.get('remote_read_file').execute({ path: '../etc/passwd' }, exec),
      /REMOTE_PATH_UNSAFE/u,
    );
  });

  it('remote_forward start / list / stop 真开隧道', async () => {
    const echo = createServer((socket) => socket.pipe(socket));
    await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const echoPort = echo.address().port;
    const started = await registered.get('remote_forward').execute(
      { action: 'start', remote_host: '127.0.0.1', remote_port: echoPort },
      exec,
    );
    assert.match(started.text, /status: started/u);
    const id = /id: (fwd-\d+)/u.exec(started.text)?.[1];
    const port = Number(/listen: 127\.0\.0\.1:(\d+)/u.exec(started.text)?.[1]);
    assert.ok(id && port > 0);

    const listed = await registered.get('remote_forward').execute({ action: 'list' }, exec);
    assert.match(listed.text, new RegExp(id, 'u'));

    const stopped = await registered.get('remote_forward').execute({ action: 'stop', forward_id: id }, exec);
    assert.match(stopped.text, /STOPPED/u);
    await waitForPortClosed(port, { timeout: 8000, message: '停掉后转发端口没有释放' });
    await new Promise((resolve) => echo.close(resolve));
  });

  it('审计日志记录动作、可增量读与导出，且不含命令输出', async () => {
    // 让「输出」来自远端文件内容：命令文本里没有这个字符串，审计只该记命令本身
    const secretOutput = 'AUDIT-SHOULD-NOT-CONTAIN-OUTPUT-9f3';
    const secretFile = join(h.workdir, 'audit-secret.txt');
    await registered.get('remote_write_file').execute({ path: secretFile, content: `${secretOutput}\\n` }, exec);
    const shown = await registered.get('remote_exec').execute({ command: `cat '${secretFile}'` }, exec);
    assert.match(shown.text, new RegExp(secretOutput, 'u'), '命令输出应包含文件内容');
    const auditFile = plugin.__testing.AUDIT_FILE;
    const raw = readFileSync(auditFile, 'utf8');
    const leaking = raw.split('\n').filter((line) => line.includes(secretOutput));
    assert.ok(leaking.length === 0, `审计里不应出现命令输出，泄漏行：${leaking.join(' | ')}`);
    for (const tool of ['remote_exec', 'remote_upload', 'remote_download', 'remote_write_file', 'remote_forward']) {
      assert.ok(raw.includes(`"tool":"${tool}"`), `审计里应记录 ${tool}`);
    }
    assert.match(raw, /"action":"approval"|"action":"forward-stop"/u);

    const read = await registered.get('remote_audit_read').execute({ cursor: 0, max_bytes: 65536 }, exec);
    const cursor = Number(/cursor: (\d+)/u.exec(read.text)?.[1]);
    assert.ok(cursor > 0 && read.text.includes('remote_exec'));

    const filtered = await registered.get('remote_audit_read').execute({ cursor: 0, tool: 'remote_exec' }, exec);
    assert.ok(!filtered.text.includes('"tool":"remote_upload"'));

    const exportPath = join(mkdtempSync(join(tmpdir(), 'dsh-rc-tools-audit-')), 'audit.csv');
    const exported = await registered.get('remote_audit_export').execute({ local_path: exportPath, format: 'csv' }, exec);
    assert.match(exported.text, /format: csv/u);
    assert.match(
      readFileSync(exportPath, 'utf8'),
      /^at,pid,host,tool,action,cmd,path,bytes,exit,status,ms,hits,outcome,id,listen,target,verified$/mu,
    );
  });
});
