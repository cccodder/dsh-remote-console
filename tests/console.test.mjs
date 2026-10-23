/**
 * Console 命令通道测试：用一个"假远端 shell"喂 PTY 字节流，验证 OSC 哨兵、
 * 回显剥离、退出码、超时与认证期拒写。不需要 ssh，也不需要真 PTY。
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

process.env.DSH_REMOTE_CONSOLE_DIR = mkdtempSync(join(tmpdir(), 'dsh-rc-console-'));
process.env.DSH_RC_NO_CLEAR = '1';

const { __testing } = await import('../lib/index.js');
const { Console, ensureDirs } = __testing;

ensureDirs();

const D_MARK = (code) => `\x1b]1337;DSH;D;${code}\x07`;

/**
 * 假远端 shell：收到一行命令后回显、产生输出、发 D 事件（退出码）。
 * 它只在测试进程里模拟 shell 行为，不执行任何真实命令。
 */
function fakeShell() {
  const output = new PassThrough();
  const emit = (text) => output.write(Buffer.from(text, 'utf8'));
  const shell = {
    output,
    writes: [],
    async write(text) {
      shell.writes.push(text);
      // 初始化写进来的 stty / PROMPT_COMMAND / clear：只回一个提示符 D 事件
      const line = text.replace(/\r$/, '');
      const command = line.startsWith(' ') ? line.slice(1) : undefined;
      if (command === undefined || command.startsWith('stty') || command.includes('PROMPT_COMMAND')) {
        emit(D_MARK(0));
        return;
      }
      queueMicrotask(() => {
        if (command.startsWith('echo ')) {
          emit(`${line}\r\n${command.slice(5)}\r\n`);
          emit(D_MARK(0));
          return;
        }
        if (command === 'false') {
          emit(`${line}\r\n`);
          emit(D_MARK(1));
          return;
        }
        if (/^exit\s+(\d+)/u.test(command)) {
          emit(`${line}\r\n`);
          emit(D_MARK(Number(/^exit\s+(\d+)/u.exec(command)[1])));
          return;
        }
        if (command.startsWith('sleep ')) return; // 永不返回：测超时
        emit(`${line}\r\n`);
        emit(D_MARK(0));
      });
    },
  };
  return shell;
}

function makeConsole() {
  const shell = fakeShell();
  const handle = {
    pid: 4321,
    output: shell.output,
    write: (text) => shell.write(text),
    terminate: async () => {},
    done: new Promise(() => {}),
  };
  const console = new Console('4321', handle, new PassThrough(), { argv: ['dsh-ssh'] });
  shell.output.on('data', (chunk) => console.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
  return { console, shell };
}

describe('Console.run（OSC 哨兵路径）', () => {
  it('返回 stdout 与退出码，并剥掉回显', async () => {
    const { console } = makeConsole();
    const result = await console.run('echo HI', 3000);
    assert.equal(result.status, 'done');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'HI');
  });

  it('非零退出码原样返回', async () => {
    const { console } = makeConsole();
    const result = await console.run('false', 3000);
    assert.equal(result.status, 'done');
    assert.equal(result.exitCode, 1);
  });

  it('exit N 的退出码不被吞掉', async () => {
    const { console } = makeConsole();
    const result = await console.run('exit 7', 3000);
    assert.equal(result.status, 'done');
    assert.equal(result.exitCode, 7);
  });

  it('超时返回 timeout 而不是猜完成', async () => {
    const { console } = makeConsole();
    const result = await console.run('sleep 10', 200);
    assert.equal(result.status, 'timeout');
    assert.equal(result.exitCode, null);
  });

  it('认证提示期间拒绝写入', async () => {
    const { console } = makeConsole();
    console.feed(Buffer.from("user@host's password: "));
    await assert.rejects(() => console.run('id', 1000), /AUTH_REQUIRED/u);
  });

  it('PTY 结束后拒绝写入', async () => {
    const { console } = makeConsole();
    console.ended = true;
    await assert.rejects(() => console.run('id', 1000), /CONSOLE_CLOSED/u);
  });
});
