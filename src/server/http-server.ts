/**
 * SPEC-011 HTTP + SSE 服务：浏览器是 Surface，Kernel 在这边。
 *
 * 零依赖，只用 node:http。默认只监听 127.0.0.1——这是本机客户端，不是服务器。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ClientSession, SessionEvent } from './session.ts';
import { ConversationRegistry } from './conversations.ts';
import { runCommand } from './commands.ts';
import { silentLogger } from '../log/logger.ts';
import type { Logger } from '../log/logger.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CLIENT_DIR = path.resolve(HERE, '..', 'client');
const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_MS = 15_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.d.ts': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export interface ServeOptions {
  session: ClientSession;
  port?: number;
  host?: string;
  clientDir?: string;
  /** 诊断日志：记录每条请求与每个服务端错误 */
  logger?: Logger;
  /** SPEC-020 多对话：给了就按 ?conversation= 取会话；不给则退化成单会话模式 */
  registry?: ConversationRegistry;
}

export interface RunningServer {
  url: string;
  port: number;
  server: http.Server;
  close(): Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        resolve(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {});
      } catch {
        reject(new Error('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 静态资源只能来自 clientDir 内部（CLI-007） */
export function resolveClientAsset(clientDir: string, urlPath: string): string | undefined {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '');
  const full = path.resolve(clientDir, relative);
  const root = path.resolve(clientDir);
  if (full !== root && !full.startsWith(root + path.sep)) return undefined;
  return full;
}

/** 单会话模式：命令里用到 registry 的地方退化成一个只有 default 的只读壳 */
function singleRegistry(session: ClientSession): ConversationRegistry {
  const registry = new ConversationRegistry({
    root: path.dirname(session.dir),
    open: () => session,
  });
  return registry;
}

export function createRequestHandler(options: ServeOptions): http.RequestListener {
  const clientDir = path.resolve(options.clientDir ?? DEFAULT_CLIENT_DIR);
  const defaultSession = options.session;
  const registry = options.registry;
  const logger = options.logger ?? silentLogger;

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname;
    const method = req.method ?? 'GET';

    // SPEC-020：所有既有路由都用 ?conversation=<id> 定位会话，省略即默认对话。
    // 用一个局部 `session` 遮蔽掉默认会话，既有路由因此**一行都不用改**。
    const conversationId = url.searchParams.get('conversation') ?? defaultSession.id ?? 'default';
    let session: ClientSession = defaultSession;
    if (registry !== undefined) {
      if (!ConversationRegistry.isValidId(conversationId)) {
        sendJson(res, 400, { ok: false, error: `BAD_CONVERSATION_ID: ${conversationId}` });
        return;
      }
      if (url.searchParams.has('conversation') || conversationId !== defaultSession.id) {
        // 显式指定了对话 = 人类切过去了；不带参数的请求不该抢走 active
        session = registry.get(conversationId, { activate: true });
      } else {
        session = registry.get(conversationId, { activate: false });
      }
    }

    // 访问日志：以前这个服务一条请求都不记，403/404/500 外部完全不可见
    const startedAt = Date.now();
    res.once('finish', () => {
      const elapsed = Date.now() - startedAt;
      const line = { method, path: route, status: res.statusCode, ms: elapsed };
      if (res.statusCode >= 500) logger.error('请求失败', line);
      else if (res.statusCode >= 400) logger.warn('请求被拒', line);
      else logger.debug('请求完成', line);
    });

    // ── SPEC-020 对话管理 ──
    if (route === '/api/conversations' && method === 'GET') {
      if (registry === undefined) {
        sendJson(res, 200, {
          ok: true,
          active: defaultSession.id,
          conversations: [
            {
              id: defaultSession.id,
              title: defaultSession.title,
              createdAt: new Date().toISOString(),
              lastActiveAt: defaultSession.lastActiveAt(),
              messages: defaultSession.messageCount(),
            },
          ],
        });
        return;
      }
      sendJson(res, 200, { ok: true, active: registry.active, conversations: registry.list() });
      return;
    }

    if (route === '/api/conversations' && method === 'POST') {
      if (registry === undefined) {
        sendJson(res, 400, { ok: false, error: '单会话模式下不支持新建对话' });
        return;
      }
      readBody(req)
        .then((body) => {
          // SPEC-015 SET-014：新对话从**当前活跃对话**继承模型配置，
          // 而不是回落到内置默认（否则用户每开一个对话都要重配一次模型与 Key）
          const source = registry.get(registry.active, { activate: false });
          const created = registry.create(typeof body.title === 'string' ? body.title : undefined);
          const inherit = registry.get(created.id);
          inherit.inheritSettingsFrom(source);
          sendJson(res, 200, { ok: true, conversation: created });
        })
        .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }));
      return;
    }

    if (route.startsWith('/api/conversations/') && method === 'DELETE') {
      if (registry === undefined) {
        sendJson(res, 400, { ok: false, error: '单会话模式下不支持删除' });
        return;
      }
      const id = decodeURIComponent(route.slice('/api/conversations/'.length));
      if (!ConversationRegistry.isValidId(id)) {
        sendJson(res, 400, { ok: false, error: 'BAD_CONVERSATION_ID' });
        return;
      }
      registry
        .delete(id)
        .then((outcome) => sendJson(res, outcome.ok ? 200 : 400, outcome.ok ? { ok: true } : { ok: false, error: outcome.error }))
        .catch((err: Error) => sendJson(res, 500, { ok: false, error: err.message }));
      return;
    }

    // ── SPEC-020 `/` 命令：服务端执行，客户端只按前缀路由 ──
    if (route === '/api/command' && method === 'POST') {
      readBody(req)
        .then((body) => {
          const text = typeof body.text === 'string' ? body.text : '';
          const result = runCommand(text, { session, registry: registry ?? singleRegistry(session) });
          sendJson(res, result.ok ? 200 : 400, result);
        })
        .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }));
      return;
    }

    // ── SPEC-021 工作空间：列表只给元信息，内容按需加载 ──
    if (route === '/api/workspace' && method === 'GET') {
      sendJson(res, 200, { ok: true, root: session.runner.workspace.root, files: session.runner.workspace.list() });
      return;
    }

    if (route === '/api/surface/versions' && method === 'GET') {
      // SPEC-025：界面版本清单（最新的排最前）
      sendJson(res, 200, { ok: true, current: session.state().document.version, versions: session.surfaceVersions() });
      return;
    }

    if (route === '/api/browser/open' && method === 'POST') {
      // SPEC-019：浏览器面板的入口 = 打开工作空间里的 HTML 文件
      readBody(req)
        .then((body) => {
          const outcome = session.openInBrowser(body.path);
          sendJson(res, outcome.ok ? 200 : 400, outcome.ok ? { ok: true, version: outcome.version, path: outcome.path } : { ok: false, error: outcome.error });
        })
        .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }));
      return;
    }

    if (route === '/api/workspace/file' && method === 'GET') {
      const target = url.searchParams.get('path') ?? '';
      const read = session.runner.workspace.read({ path: target });
      if (!read.ok) {
        sendJson(res, 400, { ok: false, error: `${read.code}: ${read.reason}` });
        return;
      }
      sendJson(res, 200, read);
      return;
    }

    if (route === '/api/history' && method === 'GET') {
      sendJson(res, 200, { ok: true, files: session.listHistory() });
      return;
    }

    if (route === '/api/history/file' && method === 'GET') {
      const read = session.readHistoryFile(url.searchParams.get('name') ?? '');
      if (!read.ok) {
        sendJson(res, 400, { ok: false, error: read.error });
        return;
      }
      sendJson(res, 200, read);
      return;
    }

    if (route === '/api/state' && method === 'GET') {
      sendJson(res, 200, session.state());
      return;
    }

    if (route === '/api/stream' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      const write = (event: SessionEvent): void => {
        try {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
        } catch {
          /* 客户端断了，下面 unsubscribe 会收尾 */
        }
      };

      const unsubscribe = session.onEvent(write);
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    if (route === '/api/message' && method === 'POST') {
      readBody(req).then((body) => {
        const text = typeof body.text === 'string' ? body.text : '';
        const result = session.send(text);
        sendJson(res, result.ok ? 202 : 400, result);
      }).catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }));
      return;
    }

    if (route === '/api/interrupt' && method === 'POST') {
      readBody(req).then((body) => {
        const reason = typeof body.reason === 'string' ? body.reason : 'human_took_over';
        sendJson(res, 200, session.interrupt(reason));
      }).catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }));
      return;
    }

    if (route === '/api/rollback' && method === 'POST') {
      readBody(req).then((body) => {
        const version = typeof body.version === 'number' ? body.version : Number(body.version);
        if (!Number.isFinite(version)) {
          sendJson(res, 400, { ok: false, error: 'BAD_VERSION' });
          return;
        }
        const result = session.rollback(version);
        sendJson(res, result.ok ? 200 : 400, result);
      }).catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }));
      return;
    }

    if (route === '/api/settings' && method === 'GET') {
      sendJson(res, 200, session.publicSettings());
      return;
    }

    if (route === '/api/settings' && method === 'PUT') {
      readBody(req).then((body) => {
        const result = session.updateSettings(body);
        sendJson(res, result.ok ? 200 : 400, result);
      }).catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }));
      return;
    }

    if (route === '/api/approval' && method === 'POST') {
      // SPEC-023：人类对被拦下的敏感动作做决定
      readBody(req)
        .then((body) => {
          const outcome = session.respondApproval(body.id, body.decision);
          sendJson(res, outcome.ok ? 200 : 400, outcome.ok ? { ok: true } : { ok: false, error: outcome.error });
        })
        .catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }));
      return;
    }

    if (route === '/api/models' && method === 'POST') {
      // SPEC-015 SET-016：按候选配置列模型（不写盘），失败给可归因的原因
      readBody(req)
        .then((body) => session.listModels(body))
        .then((result) => sendJson(res, result.ok ? 200 : 400, result))
        .catch((err: Error) => sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: err.message }));
      return;
    }

    if (route === '/api/settings/test' && method === 'POST') {
      readBody(req)
        .then((body) => session.testSettings(body))
        .then((result) => sendJson(res, 200, result))
        .catch((err: Error) => sendJson(res, 200, { ok: false, error: err.message }));
      return;
    }

    if (route === '/api/browser/event' && method === 'POST') {
      // SPEC-019：人类在内置浏览器里的交互回流。校验失败一律 400，且不落日志。
      readBody(req).then((body) => {
        const outcome = session.browserEvent(body);
        sendJson(res, outcome.ok ? 200 : 400, outcome.ok ? { ok: true } : { ok: false, error: outcome.error });
      }).catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }));
      return;
    }

    if (route === '/api/client/revert' && method === 'POST') {
      readBody(req).then((body) => {
        const target = typeof body.path === 'string' ? body.path : '';
        if (target === '') {
          sendJson(res, 400, { ok: false, error: 'BAD_PATH' });
          return;
        }
        const version = typeof body.version === 'number' ? body.version : undefined;
        const result = session.revertClient(target, version);
        sendJson(res, result.ok ? 200 : 400, result);
      }).catch((err: Error) => sendJson(res, 400, { ok: false, error: err.message }));
      return;
    }

    if (method === 'GET') {
      const asset = resolveClientAsset(clientDir, route);
      if (asset === undefined) {
        sendJson(res, 403, { ok: false, error: 'FORBIDDEN_PATH' });
        return;
      }
      if (!fs.existsSync(asset) || !fs.statSync(asset).isFile()) {
        sendJson(res, 404, { ok: false, error: 'NOT_FOUND', path: route });
        return;
      }
      const ext = asset.endsWith('.d.ts') ? '.d.ts' : path.extname(asset);
      const body = fs.readFileSync(asset);
      res.writeHead(200, {
        'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  };
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 4311;
  const server = http.createServer(createRequestHandler(options));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        server.close(finish);
        // keep-alive 连接会让 close() 一直等：主动断开，且补一刀防竞态
        server.closeAllConnections?.();
        const timer = setTimeout(() => {
          server.closeAllConnections?.();
          finish();
        }, 50);
        timer.unref?.();
      }),
  };
}
