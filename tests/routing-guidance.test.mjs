/**
 * 选路引导：让模型分清「可见 PTY」和「带外 exec」。
 *
 * 三层：
 *  - 层 1：systemPrompt.section 只在有存活终端时注入几条判据（没有终端返回空串，不占 prompt）；
 *  - 层 2：工具描述意图优先（用注册出来的 description 断言，防止改回机制叙述）；
 *  - 层 3：结果纠正——PTY 输出过大提示改走带外，exec 撞上「需要 tty」提示改走 PTY。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, it } from 'node:test';

const rcDir = mkdtempSync(join(tmpdir(), 'dsh-rc-routing-'));
const sshConfig = join(rcDir, 'ssh_config');
writeFileSync(sshConfig, 'Host alpha\n  HostName 10.0.0.1\n');
process.env.DSH_REMOTE_CONSOLE_DIR = rcDir;
process.env.DSH_SSH_CONFIG = sshConfig;
process.env.DSH_RC_NO_CLEAR = '1';

const plugin = await import('../lib/index.js');
const { apply } = plugin;
const { state, routingPromptText, runOutputHint, ttyHint, statusGuide, ROUTING_SECTION_NAME } = plugin.__testing;

function makeCtx({ withSystemPrompt = true } = {}) {
  const registered = [];
  const sections = [];
  const tools = { register: (definition) => (registered.push(definition), () => {}) };
  const systemPrompt = withSystemPrompt
    ? {
        section(section) {
          sections.push(section);
          return () => {
            const index = sections.indexOf(section);
            if (index >= 0) sections.splice(index, 1);
          };
        },
      }
    : undefined;
  const controller = {
    shells: async () => [{ path: '/bin/bash', name: 'bash', args: ['-i'] }],
    list: () => [],
    retain: () => ({ type: 'retained' }),
  };
  const subprocess = {
    spawnTerminal: async () => ({
      pid: 7000 + registered.length,
      output: new PassThrough(),
      write: async () => {},
      terminate: async () => {},
      done: new Promise(() => {}),
    }),
  };
  const ctx = {
    subprocess,
    terminalController: controller,
    get(name) {
      if (name === 'tools') return tools;
      if (name === 'systemPrompt') return systemPrompt;
      return undefined;
    },
    inject(deps, callback) {
      if (deps.includes('systemPrompt') && systemPrompt !== undefined) callback(ctx);
      return () => {};
    },
    effect(factory) {
      const disposer = factory();
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    on() {},
    logger: { info() {}, warn() {}, debug() {}, error() {} },
  };
  return { ctx, registered, sections };
}

const liveCover = (overrides = {}) => ({
  pid: '4242',
  host: 'alpha',
  socket: '/tmp/fake.sock',
  ended: false,
  createdAt: 1,
  events: [],
  ...overrides,
});

describe('层 1：系统提示 section', () => {
  beforeEach(() => state().consoles.clear());

  it('没有存活终端时注册了 section，但文本为空（不占 prompt）', () => {
    const { ctx, sections } = makeCtx();
    apply(ctx);
    const section = sections.find((entry) => entry.name === ROUTING_SECTION_NAME);
    assert.ok(section, '应注册选路 section');
    assert.equal(section.order, 1750);
    assert.equal(routingPromptText(), '');
    assert.equal(section.text(), '');
  });

  it('有终端时给出判据：可见通道默认、带外用于采集、指向 remote_status', () => {
    state().consoles.set('4242', liveCover());
    const { ctx, sections } = makeCtx();
    apply(ctx);
    const section = sections.find((entry) => entry.name === ROUTING_SECTION_NAME);
    const text = section.text();
    assert.match(text, /remote_run/u);
    assert.match(text, /remote_exec/u);
    assert.match(text, /remote_status/u);
    assert.match(text, /alpha/u);
    assert.match(text, /默认/u);
  });

  it('终端退出后 section 不再输出任何内容', () => {
    state().consoles.set('4242', liveCover({ ended: true }));
    assert.equal(routingPromptText(), '');
  });

  it('没有 systemPrompt 服务的部署不注册、也不报错', () => {
    const { ctx, sections } = makeCtx({ withSystemPrompt: false });
    assert.doesNotThrow(() => apply(ctx));
    assert.equal(sections.length, 0);
  });
});

describe('层 2：工具描述意图优先', () => {
  it('remote_run 说明这是用户在看的那条通道，并把数据采集指向 remote_exec', () => {
    state().consoles.clear();
    const { ctx, registered } = makeCtx();
    apply(ctx);
    const run = registered.find((tool) => tool.name === 'remote_run');
    const exec = registered.find((tool) => tool.name === 'remote_exec');
    assert.match(run.description, /Visible channel/u);
    assert.match(run.description, /SAME terminal the user is watching/u);
    assert.match(run.description, /use remote_exec/u);
    assert.match(exec.description, /Out-of-band channel/u);
    assert.match(exec.description, /Do NOT use it when the command needs a tty/u);
    assert.match(exec.description, /use remote_run instead/u);
  });
});

describe('层 3：结果纠正', () => {
  it('remote_run 输出很大时提示下次用 remote_exec，小输出不打扰', () => {
    assert.equal(runOutputHint('short'), '');
    assert.equal(runOutputHint('x'.repeat(8192)), '');
    const hint = runOutputHint('x'.repeat(8193));
    assert.match(hint, /remote_exec/u);
  });

  it('remote_exec 命中「需要 tty/密码」才提示改走 remote_run', () => {
    assert.match(ttyHint('sudo: a password is required', 1), /remote_run/u);
    assert.match(ttyHint('the input device is not a tty', 1), /remote_run/u);
    assert.match(ttyHint('sudo: a terminal is required to read the password', 1), /remote_run/u);
    // 成功、非 tty 类错误都不提示
    assert.equal(ttyHint('sudo: a password is required', 0), '');
    assert.equal(ttyHint('ls: cannot access /nope', 2), '');
    assert.equal(ttyHint('', null), '');
  });

  it('remote_status 顶部给通道摘要与选路提示', () => {
    const guide = statusGuide([liveCover(), liveCover({ pid: '5', socket: '' })]);
    assert.match(guide, /^channel: socket/u);
    assert.match(guide, /1\/2/u);
    assert.match(guide, /routing:/u);
    assert.match(guide, /remote_run/u);
    const ptyGuide = statusGuide([liveCover({ socket: '' })]);
    assert.match(ptyGuide, /^channel: pty/u);
    assert.match(ptyGuide, /1 MiB/u);
  });
});
