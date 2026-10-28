/**
 * 会话归属：工具只能操作调用方会话自己打开的终端。
 *
 * 回归背景：宿主进程里所有会话共用一个 console 表，旧代码解析 `console_pid` 时只看 pid、
 * `newestConsole()` 默认不带会话过滤——同进程里的任何会话都能读别人的屏幕、执行命令、
 * 传文件。这里锁住修复后的行为，也锁住「两边信息不全时退回旧行为」的边界。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

process.env.DSH_REMOTE_CONSOLE_DIR = mkdtempSync(join(tmpdir(), 'dsh-rc-session-'));
process.env.DSH_RC_NO_CLEAR = '1';

const plugin = await import('../lib/index.js');
const { state, currentSessionId, sessionMismatch, consolesForSession, requireConsole, AUDIT_FILE } = plugin.__testing;

const SESSION_A = 'session-aaaa';
const SESSION_B = 'session-bbbb';

function makeCover(pid, sessionId, createdAt = 1) {
  return { pid, sessionId, createdAt, ended: false, host: 'example', events: [] };
}

/** 工具执行上下文：DSH 用 exec.agent.id 表示调用方会话。 */
const execOf = (sessionId) => (sessionId === undefined ? {} : { agent: { id: sessionId } });

function setConsoles(...covers) {
  const shared = state();
  shared.consoles.clear();
  for (const cover of covers) shared.consoles.set(String(cover.pid), cover);
}

describe('currentSessionId', () => {
  it('从 exec.agent.id 取调用方会话；缺失/空值时返回 undefined', () => {
    assert.equal(currentSessionId(execOf(SESSION_A)), SESSION_A);
    assert.equal(currentSessionId(undefined), undefined);
    assert.equal(currentSessionId({}), undefined);
    assert.equal(currentSessionId({ agent: {} }), undefined);
    assert.equal(currentSessionId({ agent: { id: '' } }), undefined);
    assert.equal(currentSessionId({ agent: { id: 42 } }), undefined);
    // 兜底：只暴露 session.header.id 的版本也能取到会话
    assert.equal(currentSessionId({ agent: { session: { header: { id: SESSION_B } } } }), SESSION_B);
  });
});

describe('sessionMismatch', () => {
  it('两边都有归属且不同才算越权；缺一边无法判定', () => {
    assert.equal(sessionMismatch(makeCover('1', SESSION_A), SESSION_A), false);
    assert.equal(sessionMismatch(makeCover('1', SESSION_B), SESSION_A), true);
    assert.equal(sessionMismatch(makeCover('1', SESSION_A), undefined), false);
    assert.equal(sessionMismatch(makeCover('1', undefined), SESSION_A), false);
  });
});

describe('requireConsole：按会话解析终端', () => {
  beforeEach(() => setConsoles());

  it('默认取本会话最新的终端，不会拿到别的会话更晚创建的那个', () => {
    setConsoles(makeCover('100', SESSION_A, 1), makeCover('200', SESSION_B, 50), makeCover('101', SESSION_A, 10));
    assert.equal(requireConsole({}, execOf(SESSION_A)).pid, '101');
    assert.equal(requireConsole({}, execOf(SESSION_B)).pid, '200');
  });

  it('显式 console_pid 属于别的会话时拒绝，并说明怎么办', () => {
    setConsoles(makeCover('100', SESSION_A), makeCover('200', SESSION_B));
    assert.throws(
      () => requireConsole({ console_pid: '200' }, execOf(SESSION_A)),
      (error) => {
        assert.match(String(error.message), /CONSOLE_FORBIDDEN/u);
        assert.match(String(error.message), /当前会话/u);
        return true;
      },
    );
    // 自己的 pid 正常
    assert.equal(requireConsole({ console_pid: '100' }, execOf(SESSION_A)).pid, '100');
  });

  it('本会话没有终端、但别的会话有时，报 NO_CONSOLE 且说明不能借用', () => {
    setConsoles(makeCover('200', SESSION_B));
    assert.throws(
      () => requireConsole({}, execOf(SESSION_A)),
      (error) => {
        assert.match(String(error.message), /NO_CONSOLE/u);
        assert.match(String(error.message), /其它会话/u);
        return true;
      },
    );
  });

  it('完全不存在的 pid 仍然是 CONSOLE_NOT_FOUND', () => {
    setConsoles(makeCover('100', SESSION_A));
    assert.throws(() => requireConsole({ console_pid: '999' }, execOf(SESSION_A)), /CONSOLE_NOT_FOUND/u);
  });

  it('调用方没有会话信息时退回旧行为（插件自测/老 DSH），不误伤', () => {
    setConsoles(makeCover('200', SESSION_B));
    assert.equal(requireConsole({ console_pid: '200' }, {}).pid, '200');
    assert.equal(requireConsole({}, {}).pid, '200');
  });

  it('终端本身没有记到会话时无法判定，允许（否则老终端全部废掉）', () => {
    setConsoles(makeCover('300', undefined));
    assert.equal(requireConsole({ console_pid: '300' }, execOf(SESSION_A)).pid, '300');
  });
});

describe('consolesForSession', () => {
  it('只返回本会话的终端；归属未知的不混进已知会话的列表', () => {
    setConsoles(makeCover('100', SESSION_A), makeCover('200', SESSION_B), makeCover('300', undefined));
    assert.deepEqual(
      consolesForSession(SESSION_A).map((cover) => cover.pid),
      ['100'],
    );
    assert.deepEqual(
      consolesForSession(undefined).map((cover) => cover.pid),
      ['100', '200', '300'],
    );
  });
});

describe('审计日志记录会话归属', () => {
  it('audit 记录里带 session，便于从 pid 追到会话', () => {
    plugin.__testing.ensureDirs();
    const cover = makeCover('9100', SESSION_A);
    plugin.__testing.audit(cover, { tool: 'remote_run', action: 'exec', cmd: 'echo hi' });
    const lines = readFileSync(AUDIT_FILE, 'utf8').trim().split('\n');
    const last = JSON.parse(lines.at(-1));
    assert.equal(last.pid, '9100');
    assert.equal(last.session, SESSION_A);
  });
});
