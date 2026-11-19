/**
 * 面板 HTTP 路由测试：用假 webServer 捕获注册的路由，再用假 req/res 直接打 handler。
 * 覆盖 rc1013 暴露的那类问题——只测纯函数会漏掉接线错误。
 *
 * 用临时 DSH_REMOTE_CONSOLE_DIR，不碰 ~/.dsh。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const rcDir = mkdtempSync(join(tmpdir(), 'dsh-rc-routes-'));
process.env.DSH_REMOTE_CONSOLE_DIR = rcDir;
process.env.DSH_RC_NO_CLEAR = '1';

const { __testing } = await import('../lib/index.js');
const {
  applyPanelRoutes,
  registerStatusRoute,
  writeAllowed,
  readRequestBody,
  STATUS_ROUTE,
  FILES_ROUTE,
  FILES_UPLOAD_ROUTE,
  HOSTS_META_ROUTE,
  FILES_HOME_ROUTE,
  PANEL_TOKEN,
  invalidateAuditRecordCache,
  ensureDirs,
  state,
} = __testing;

ensureDirs();

function makeWebServer() {
  const routes = new Map();
  return {
    routes,
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
}

function req(method, url, headers = {}) {
  return { method, url, headers };
}

function res() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('面板路由注册', () => {
  it('applyPanelRoutes 注册所有面板路由，dispose 全部注销', () => {
    const webServer = makeWebServer();
    applyPanelRoutes({ get: () => webServer });
    assert.ok(webServer.routes.has(STATUS_ROUTE));
    assert.ok(webServer.routes.has(FILES_ROUTE));
    assert.ok(webServer.routes.has(FILES_UPLOAD_ROUTE));
    const count = webServer.routes.size;
    // dispose 由 applyPanelRoutes 返回；这里再注册一次验证返回的是 disposer
    const webServer2 = makeWebServer();
    const dispose = applyPanelRoutes({ get: () => webServer2 });
    assert.ok(webServer2.routes.has(STATUS_ROUTE));
    dispose();
    assert.equal(webServer2.routes.size, 0, 'dispose 注销自己注册的全部路由');
    assert.equal(webServer.routes.size, count, '另一组路由不受影响');
  });

  it('registerStatusRoute 在 webServer 晚到时也能注册（rc1013 修复回归）', () => {
    let callback;
    const ctx = {
      get: (name) => {
        if (name === 'webServer') return undefined; // apply 时还没有
        return undefined;
      },
      inject: (deps, fn) => {
        assert.deepEqual(deps, ['webServer']);
        callback = fn;
        return () => {};
      },
    };
    registerStatusRoute(ctx);
    assert.equal(callback === undefined, false, '必须走 inject 等依赖');
    const webServer = makeWebServer();
    callback({ get: () => webServer });
    assert.ok(webServer.routes.has(STATUS_ROUTE), 'webServer 到位后路由要注册上');
  });
});

describe('状态路由 handler', () => {
  const webServer = makeWebServer();
  applyPanelRoutes({ get: () => webServer });
  const state = webServer.routes.get(STATUS_ROUTE);

  it('非 GET 返回 405', () => {
    const response = res();
    state.handler(req('POST', STATUS_ROUTE), response);
    assert.equal(response.statusCode, 405);
  });

  it('跨站 Origin 返回 403，同源放行', () => {
    const blocked = res();
    state.handler(req('GET', STATUS_ROUTE, { host: '127.0.0.1:3099', origin: 'http://evil.example' }), blocked);
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.body, 'forbidden');

    const allowed = res();
    state.handler(req('GET', STATUS_ROUTE, { host: '127.0.0.1:3099', origin: 'http://127.0.0.1:3099' }), allowed);
    assert.equal(allowed.statusCode, 200);
  });

  it('GET 回 JSON，含 token 与审计计数，且 no-store', () => {
    invalidateAuditRecordCache();
    writeFileSync(join(rcDir, 'audit', 'audit.jsonl'), '', { flag: 'a' });
    const response = res();
    state.handler(req('GET', STATUS_ROUTE), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const data = JSON.parse(response.body);
    assert.equal(data.token, PANEL_TOKEN);
    assert.equal(typeof data.consoles, 'number');
    assert.equal(typeof data.audit.commands24h, 'number');
  });
});

describe('文件路由 handler', () => {
  const webServer = makeWebServer();
  applyPanelRoutes({ get: () => webServer });
  const files = webServer.routes.get(FILES_ROUTE);
  // handler 先校验终端是否活着，再校验路径；放一个假终端让路径分支可达
  state().consoles.set('route-test', { pid: 'route-test', ended: false, socket: '/tmp/fake.sock', host: 'demo' });

  it('相对路径返回 400', async () => {
    const response = res();
    files.handler(req('GET', `${FILES_ROUTE}?pid=route-test&path=relative/x`), response);
    await tick();
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /absolute/u);
  });

  it('含 .. 的路径返回 400', async () => {
    const response = res();
    files.handler(req('GET', `${FILES_ROUTE}?pid=route-test&path=/srv/../etc`), response);
    await tick();
    assert.equal(response.statusCode, 400);
  });
});

describe('写路由安全闸', () => {
  it('writeAllowed 依次检查方法、同源、令牌、Content-Type', () => {
    const host = '127.0.0.1:3099';
    const origin = `http://${host}`;
    const good = { method: 'POST', headers: { host, origin, 'x-dsh-rc-token': PANEL_TOKEN, 'content-type': 'application/octet-stream' } };
    assert.equal(writeAllowed(good), null);
    assert.equal(writeAllowed({ ...good, method: 'GET' }), 'method');
    assert.equal(writeAllowed({ ...good, headers: { ...good.headers, origin: 'http://evil.example' } }), 'origin');
    assert.equal(writeAllowed({ ...good, headers: { ...good.headers, 'x-dsh-rc-token': 'wrong' } }), 'token');
    assert.equal(writeAllowed({ ...good, headers: { ...good.headers, 'content-type': 'text/plain' } }), 'content-type');
  });

  it('写 handler 无令牌时 403，且不会读 body', async () => {
    const webServer = makeWebServer();
    applyPanelRoutes({ get: () => webServer });
    const upload = webServer.routes.get(FILES_UPLOAD_ROUTE);
    const response = res();
    upload.handler(req('POST', `${FILES_UPLOAD_ROUTE}?pid=none&path=/tmp/x`, { host: '127.0.0.1:3099', origin: 'http://127.0.0.1:3099' }), response);
    await tick();
    assert.equal(response.statusCode, 403);
    assert.equal(response.body, 'token');
  });
});


describe('主机元信息路由', () => {
  const webServer = makeWebServer();
  applyPanelRoutes({ get: () => webServer });
  const route = webServer.routes.get(HOSTS_META_ROUTE);

  it('非 GET 405、跨站 403', () => {
    const bad = res();
    route.handler(req('POST', HOSTS_META_ROUTE), bad);
    assert.equal(bad.statusCode, 405);
    const cross = res();
    route.handler(req('GET', HOSTS_META_ROUTE, { host: '127.0.0.1:3099', origin: 'http://evil.example' }), cross);
    assert.equal(cross.statusCode, 403);
  });

  it('GET 回 { hosts } 且每项含链路结论字段', () => {
    const response = res();
    route.handler(req('GET', HOSTS_META_ROUTE), response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const data = JSON.parse(response.body);
    assert.ok(Array.isArray(data.hosts));
    for (const host of data.hosts) {
      assert.equal(typeof host.host, 'string');
      assert.ok(Array.isArray(host.jumpChain));
      assert.equal(typeof host.jumpOk, 'boolean');
    }
  });
});


describe('远端 home 路由', () => {
  const webServer = makeWebServer();
  applyPanelRoutes({ get: () => webServer });
  const route = webServer.routes.get(FILES_HOME_ROUTE);

  it('非 GET 405、跨站 403、无活终端 404', async () => {
    const method = res();
    route.handler(req('POST', FILES_HOME_ROUTE), method);
    await tick();
    assert.equal(method.statusCode, 405);
    const origin = res();
    route.handler(req('GET', `${FILES_HOME_ROUTE}?pid=none`, { host: '127.0.0.1:3099', origin: 'http://evil.example' }), origin);
    await tick();
    assert.equal(origin.statusCode, 403);
    const missing = res();
    route.handler(req('GET', `${FILES_HOME_ROUTE}?pid=none`), missing);
    await tick();
    assert.equal(missing.statusCode, 404);
  });
});


describe('上传请求体边界', () => {
  it('超限拒绝但不 destroy socket，让 413 能返回浏览器', async () => {
    const request = new EventEmitter();
    let destroyed = false;
    request.destroy = () => { destroyed = true; };
    const reading = readRequestBody(request, 4);
    const rejected = assert.rejects(reading, /TOO_LARGE/u);
    request.emit('data', Buffer.from('12345'));
    await rejected;
    request.emit('data', Buffer.from('more'));
    request.emit('end');
    assert.equal(destroyed, false);
  });

  it('未超限仍返回完整 body', async () => {
    const request = new EventEmitter();
    const reading = readRequestBody(request, 5);
    request.emit('data', Buffer.from('ab'));
    request.emit('data', Buffer.from('cd'));
    request.emit('end');
    assert.equal((await reading).toString(), 'abcd');
  });
});
