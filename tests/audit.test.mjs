/**
 * 审计日志：只记 agent 动作、不含屏幕内容、跨会话保留、可导出。
 * 用临时 DSH_REMOTE_CONSOLE_DIR，不碰 ~/.dsh。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

process.env.DSH_REMOTE_CONSOLE_DIR = mkdtempSync(join(tmpdir(), 'dsh-rc-audit-'));
process.env.DSH_RC_AUDIT_MAX_BYTES = '2048';

const { __testing } = await import('../lib/index.js');
const { audit, readAudit, exportAudit, auditFiles, AUDIT_FILE, ensureDirs } = __testing;

const cover = { pid: '4242', host: 'demo-host' };

/** 每个用例从空审计目录开始（滚动文件一起清）。 */
function reset() {
  ensureDirs();
  for (const file of [`${AUDIT_FILE}.5`, `${AUDIT_FILE}.4`, `${AUDIT_FILE}.3`, `${AUDIT_FILE}.2`, `${AUDIT_FILE}.1`, AUDIT_FILE]) {
    rmSync(file, { force: true });
  }
}

describe('审计日志', () => {
  it('写入带时间/pid/host 的 JSONL，文件权限 0600', () => {
    reset();
    audit(cover, { tool: 'remote_run', action: 'run', cmd: 'echo hi', exit: 0, status: 'done', ms: 12 });
    const raw = readFileSync(AUDIT_FILE, 'utf8');
    const record = JSON.parse(raw.trim());
    assert.equal(record.tool, 'remote_run');
    assert.equal(record.action, 'run');
    assert.equal(record.pid, '4242');
    assert.equal(record.host, 'demo-host');
    assert.equal(record.exit, 0);
    assert.match(record.at, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(statSync(AUDIT_FILE).mode & 0o777, 0o600);
  });

  it('命令文本脱敏，不落明文凭据', () => {
    reset();
    audit(cover, { tool: 'remote_exec', action: 'exec', cmd: 'curl -H "Authorization: Bearer abcdefghijklmn" x', exit: 0 });
    audit(cover, { tool: 'remote_exec', action: 'exec', cmd: 'export TOKEN=s3cr3tvalue && run', exit: 0 });
    const raw = readFileSync(AUDIT_FILE, 'utf8');
    assert.ok(!raw.includes('abcdefghijklmn'), 'Bearer token 不应落盘');
    assert.ok(!raw.includes('s3cr3tvalue'), 'token 赋值不应落盘');
    assert.match(raw, /\[REDACTED\]/u);
  });

  it('cursor 增量读取，tool 过滤不破坏 cursor', () => {
    reset();
    for (let index = 0; index < 5; index += 1) {
      audit(cover, { tool: index % 2 === 0 ? 'remote_run' : 'remote_upload', action: 'x', cmd: `cmd-${index}` });
    }
    const first = readAudit({ cursor: 0, maxBytes: 65536 });
    assert.ok(first.data.includes('cmd-0'));
    assert.equal(first.lines, 5);
    const second = readAudit({ cursor: first.cursor, maxBytes: 65536 });
    assert.equal(second.data, '', '读完后 cursor 处没有新内容');
    const onlyRun = readAudit({ cursor: 0, maxBytes: 65536, tool: 'remote_run' });
    assert.equal(onlyRun.lines, 5);
    assert.equal(onlyRun.filtered, 2);
    assert.ok(onlyRun.data.includes('cmd-0') && !onlyRun.data.includes('cmd-1'));
  });

  it('导出 jsonl 与 csv', () => {
    reset();
    audit(cover, { tool: 'remote_upload', action: 'upload', path: '/tmp/a,b.txt', bytes: 3, verified: true });
    audit(cover, { tool: 'remote_forward', action: 'forward-start', id: 'fwd-1', listen: '127.0.0.1:9000', target: 'db:5432' });
    const dir = mkdtempSync(join(tmpdir(), 'dsh-rc-audit-export-'));
    const jsonlPath = join(dir, 'out.jsonl');
    const jsonl = exportAudit({ localPath: jsonlPath, format: 'jsonl' });
    assert.equal(jsonl.records, 2);
    assert.equal(statSync(jsonlPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(jsonlPath, 'utf8').split('\n').filter((line) => line !== '').length, 2);

    const csvPath = join(dir, 'out.csv');
    const csv = exportAudit({ localPath: csvPath, format: 'csv' });
    assert.equal(csv.records, 2);
    const lines = readFileSync(csvPath, 'utf8').trim().split('\n');
    assert.match(lines[0], /^at,pid,host,tool,action,cmd,path,bytes/u);
    // 含逗号的字段必须被引号包起来
    assert.ok(lines.some((line) => line.includes('"/tmp/a,b.txt"')));
  });

  it('超过上限会滚动，旧文件仍可读', () => {
    reset();
    const pad = 'x'.repeat(80);
    for (let index = 0; index < 120; index += 1) {
      audit(cover, { tool: 'remote_run', action: 'run', cmd: `cmd-${index}-${pad}`, exit: 0 });
    }
    const files = auditFiles();
    assert.ok(files.length >= 2, `应该滚出至少一个旧文件：${files.join(', ')}`);
    assert.ok(files.some((file) => file.endsWith('.1')), 'audit.jsonl.1 应该存在');
    const all = readAudit({ cursor: 0, maxBytes: 262144 });
    assert.ok(all.lines >= 20, '滚动后仍能读到记录');
    assert.equal(all.total, auditFiles().reduce((sum, file) => sum + statSync(file).size, 0));
  });

  it('DSH_RC_AUDIT=off 停止写入，读/导出仍可用', () => {
    reset();
    audit(cover, { tool: 'remote_run', action: 'run', cmd: 'before-off' });
    process.env.DSH_RC_AUDIT = 'off';
    try {
      audit(cover, { tool: 'remote_run', action: 'run', cmd: 'while-off' });
    } finally {
      delete process.env.DSH_RC_AUDIT;
    }
    const raw = readFileSync(AUDIT_FILE, 'utf8');
    assert.ok(raw.includes('before-off'));
    assert.ok(!raw.includes('while-off'));
    assert.equal(existsSync(AUDIT_FILE), true);
    const exported = exportAudit({ localPath: join(mkdtempSync(join(tmpdir(), 'dsh-rc-audit-off-')), 'a.jsonl') });
    assert.equal(exported.records, 1);
  });
});
