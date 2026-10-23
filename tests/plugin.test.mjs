/**
 * 插件装载测试：用假的 Cordis ctx 跑 `apply()`，检查
 *  - 6 个 agent 工具都通过 defineTool 校验并注册
 *  - shells() 追加主机启动器，且会清理失效启动器
 *  - spawnTerminal 包装只接管 dsh-ssh* 进程，并把 output 换成 tee
 *  - 危险命令守卫在没有审批服务时 fail closed
 *
 * 不需要 ssh、不需要跑起 DSH。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

const rcDir = mkdtempSync(join(tmpdir(), 'dsh-rc-plugin-'));
const sshConfig = join(rcDir, 'ssh_config');
writeFileSync(sshConfig, 'Host alpha\n  HostName 10.0.0.1\nHost beta\n  HostName 10.0.0.2\n');
process.env.DSH_REMOTE_CONSOLE_DIR = rcDir;
process.env.DSH_SSH_CONFIG = sshConfig;
process.env.DSH_RC_NO_CLEAR = '1';

const plugin = await import('../lib/index.js');
const { apply, __testing } = plugin;
const { state, paths } = __testing;

function makeCtx() {
  const registered = [];
  const tools = {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  };
  const controller = {
    shells: async () => [{ path: '/bin/bash', name: 'bash', args: ['-i'] }],
    list: () => [],
    retain: () => ({ type: 'retained' }),
  };
  const handles = [];
  const subprocess = {
    spawnTerminal: async (spec) => {
      const handle = {
        pid: 9000 + handles.length,
        spec,
        output: new PassThrough(),
        write: async () => {},
        terminate: async () => {},
        done: new Promise(() => {}),
      };
      handles.push(handle);
      return handle;
    },
  };
  const ctx = {
    subprocess,
    terminalController: controller,
    get(name) {
      if (name === 'tools') return tools;
      return undefined;
    },
  };
  return { ctx, registered, handles };
}

describe('apply()', () => {
  const { ctx, registered } = makeCtx();
  const before = ctx.subprocess.spawnTerminal;
  const dispose = apply(ctx);

  it('注册全部 6 个工具', () => {
    const names = registered.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['remote_close', 'remote_exec', 'remote_log', 'remote_run', 'remote_screen', 'remote_status']);
    for (const tool of registered) {
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.output.schema.type, 'object');
    }
  });

  it('包装 spawnTerminal 但只接管 dsh-ssh*', async () => {
    assert.notEqual(ctx.subprocess.spawnTerminal, before);
    assert.equal(ctx.subprocess.spawnTerminal.__dshRc, true);

    const plain = await ctx.subprocess.spawnTerminal({ argv: ['/bin/bash', '-i'] });
    assert.equal(plain.output.constructor, PassThrough);
    assert.equal(state().consoles.size, 0);

    const launcher = join(paths.BIN_DIR, 'dsh-ssh-alpha');
    const wrapped = await ctx.subprocess.spawnTerminal({ argv: [launcher], env: {} });
    assert.notEqual(wrapped.output, plain.output, 'output 必须换成 tee');
    assert.equal(state().consoles.size, 1);
  });

  it('shells() 追加主机启动器并清理失效启动器', async () => {
    const stale = join(paths.BIN_DIR, 'dsh-ssh-obsolete');
    writeFileSync(stale, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const shells = await ctx.terminalController.shells(undefined, undefined);
    const names = shells.map((shell) => shell.name);
    assert.ok(names.includes('bash'), '原有 shell 必须保留');
    assert.ok(names.includes('SSH alpha'));
    assert.ok(names.includes('SSH beta'));
    assert.ok(names.includes('SSH 新建会话'));
    assert.ok(!existsSync(stale), 'ssh config 里已不存在的主机，启动器要删掉');
    const launchers = readdirSync(paths.BIN_DIR).filter((file) => file.startsWith('dsh-ssh-'));
    assert.deepEqual(launchers.sort(), ['dsh-ssh-alpha', 'dsh-ssh-beta', 'dsh-ssh-new']);
  });

  it('危险命令没有审批服务时 fail closed', async () => {
    const { gateDangerousCommand } = __testing;
    const exec = { agent: { id: 'a1' }, callId: 'c1', signal: undefined };
    await assert.rejects(() => gateDangerousCommand(ctx, exec, 'rm -rf /', 'remote_exec'), /DANGEROUS_BLOCKED/u);
  });

  it('危险命令在批准后放行、拒绝时报错', async () => {
    const { gateDangerousCommand } = __testing;
    const asked = [];
    const guardedCtx = {
      get(name) {
        if (name !== 'approval') return undefined;
        return {
          async request(req) {
            asked.push(req);
            return asked.length === 1 ? 'allowed-once' : 'rejected';
          },
        };
      },
    };
    const exec = { agent: { id: 'a1' }, callId: 'c1' };
    await gateDangerousCommand(guardedCtx, exec, 'reboot', 'remote_run');
    assert.equal(asked.length, 1);
    assert.match(asked[0].reason, /shutdown-or-reboot/u);
    await assert.rejects(() => gateDangerousCommand(guardedCtx, exec, 'reboot', 'remote_run'), /DANGEROUS_REJECTED/u);

    // 安全命令不触发审批
    await gateDangerousCommand(guardedCtx, exec, 'ls -la', 'remote_run');
    assert.equal(asked.length, 2);
  });

  it('会结束终端的命令（exit）在 remote_run 上要审批', async () => {
    const { gateDangerousCommand } = __testing;
    const asked = [];
    const guardedCtx = {
      get(name) {
        if (name !== 'approval') return undefined;
        return {
          async request(req) {
            asked.push(req);
            return 'allowed-once';
          },
        };
      },
    };
    const exec = { agent: { id: 'a1' }, callId: 'c1' };

    // remote_run 上要拦
    await gateDangerousCommand(guardedCtx, exec, 'cd /tmp; exit 42', 'remote_run', undefined, {
      checkTerminating: true,
    });
    assert.equal(asked.length, 1);
    assert.match(asked[0].reason, /结束整个 SSH 终端/u);
    assert.match(asked[0].reason, /shell-exit/u);

    // remote_exec 是 sh -c 子进程，exit 不会结束 console，不拦
    await gateDangerousCommand(guardedCtx, exec, 'exit 42', 'remote_exec');
    assert.equal(asked.length, 1);
  });

  it('dispose 不抛错（保留运行中的包装）', () => {
    assert.equal(typeof dispose, 'function');
    dispose();
  });
});
