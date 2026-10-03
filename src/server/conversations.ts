/**
 * SPEC-020 多对话：一个对话 = 一个独立单元。
 *
 * 每个对话有自己的目录、自己的 Lead 子进程、自己的界面/浏览器文档与事件日志。
 * 这个注册表负责三件事：按 id 惰性开门、生成新 id、以及**遍历时保证 id 不越界**。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ClientSession } from './session.ts';

export const DEFAULT_CONVERSATION_ID = 'default';

/** id 规则：小写字母数字开头，允许 - 与 _，总长 ≤ 32。刻意收窄，因为它是目录名。 */
export const CONVERSATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  messages: number;
}

interface Meta {
  id: string;
  title: string;
  createdAt: string;
}

export interface ConversationRegistryOptions {
  /** 所有对话的父目录：`<root>/conversations/<id>` */
  root: string;
  /** 打开一个对话（惰性，不创建目录、不拉子进程） */
  open: (id: string, dir: string) => ClientSession;
}

export class ConversationRegistry {
  readonly root: string;
  #open: (id: string, dir: string) => ClientSession;
  #sessions = new Map<string, ClientSession>();
  #active = DEFAULT_CONVERSATION_ID;

  constructor(options: ConversationRegistryOptions) {
    this.root = path.resolve(options.root);
    this.#open = options.open;
  }

  get active(): string {
    return this.#active;
  }

  /** 传进来的 id 是否合法（不合法就不该被拿去拼路径） */
  static isValidId(id: unknown): id is string {
    return typeof id === 'string' && CONVERSATION_ID_PATTERN.test(id) && !id.includes('..');
  }

  /**
   * SPEC-026 SET-019：确保全局默认存在。
   *
   * 升级场景用它把「当前活跃对话配过的模型」提升为全局默认，
   * 于是「新对话用我配过的模型」这个既有预期不退化，且此后全局是单一事实来源。
   */
  ensureGlobalFrom(source: ClientSession): { created: boolean; from: string } {
    return source.ensureGlobalSettings();
  }

  /** 全局默认（给设置页看） */
  globalSettings(): ReturnType<ClientSession['globalSettings']> {
    return this.get(this.#active, { activate: false }).globalSettings();
  }

  dirFor(id: string): string {
    if (!ConversationRegistry.isValidId(id)) throw new Error(`非法对话 id：${String(id)}`);
    return path.join(this.root, 'conversations', id);
  }

  /**
   * 拿一个对话（没有就建目录与 meta）。同样的 id 一定拿到同一个实例 ——
   * 否则界面文档/子进程会被悄悄开成两份。
   */
  get(id: string = DEFAULT_CONVERSATION_ID, options: { activate?: boolean } = {}): ClientSession {
    if (!ConversationRegistry.isValidId(id)) throw new Error(`非法对话 id：${String(id)}`);
    const activate = options.activate ?? true;
    const existing = this.#sessions.get(id);
    if (existing !== undefined) {
      if (activate) this.#active = id;
      return existing;
    }

    const dir = this.dirFor(id);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, 'meta.json'))) {
      this.#writeMeta(dir, { id, title: id === DEFAULT_CONVERSATION_ID ? '默认对话' : id, createdAt: new Date().toISOString() });
    }
    const session = this.#open(id, dir);
    this.#sessions.set(id, session);
    if (activate) this.#active = id;
    return session;
  }

  /** 只读地看一眼某个 id 是否已经存在（不创建） */
  exists(id: string): boolean {
    return ConversationRegistry.isValidId(id) && fs.existsSync(path.join(this.dirFor(id), 'meta.json'));
  }

  create(title?: string): ConversationSummary {
    const clean = typeof title === 'string' && title.trim() !== '' ? title.trim().slice(0, 60) : '新对话';
    let index = 1;
    // 生成 id 时避开已存在的：绝不覆盖别人的对话
    while (this.exists(`c${index}`) || this.#sessions.has(`c${index}`)) index += 1;
    const id = `c${index}`;

    const dir = this.dirFor(id);
    fs.mkdirSync(dir, { recursive: true });
    const createdAt = new Date().toISOString();
    this.#writeMeta(dir, { id, title: clean, createdAt });
    this.#active = id;
    return { id, title: clean, createdAt, lastActiveAt: createdAt, messages: 0 };
  }

  async delete(id: string): Promise<{ ok: boolean; error?: string }> {
    if (!ConversationRegistry.isValidId(id)) return { ok: false, error: 'BAD_ID' };
    if (id === DEFAULT_CONVERSATION_ID) return { ok: false, error: '默认对话不可删除' };

    const session = this.#sessions.get(id);
    if (session !== undefined) {
      await session.close();
      this.#sessions.delete(id);
    }

    const dir = this.dirFor(id);
    // 删之前再确认一次：解析结果必须在 conversations 根之内
    const base = path.resolve(this.root, 'conversations');
    const target = path.resolve(dir);
    if (!target.startsWith(`${base}${path.sep}`)) return { ok: false, error: 'PATH_ESCAPE' };
    fs.rmSync(target, { recursive: true, force: true });

    if (this.#active === id) this.#active = DEFAULT_CONVERSATION_ID;
    return { ok: true };
  }

  list(): ConversationSummary[] {
    const conversations: ConversationSummary[] = [];
    const base = path.join(this.root, 'conversations');

    const ids = new Set<string>(this.#sessions.keys());
    if (fs.existsSync(base)) {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory() && ConversationRegistry.isValidId(entry.name)) ids.add(entry.name);
      }
    }
    ids.add(DEFAULT_CONVERSATION_ID);

    for (const id of ids) {
      const dir = this.dirFor(id);
      const meta = this.#readMeta(dir, id);
      const session = this.#sessions.get(id);
      conversations.push({
        id,
        title: meta.title,
        createdAt: meta.createdAt,
        lastActiveAt: session?.lastActiveAt() ?? meta.createdAt,
        messages: session?.messageCount() ?? 0,
      });
    }

    // 当前活跃的排最前，其余按创建时间
    return conversations.sort((a, b) => {
      if (a.id === this.#active) return -1;
      if (b.id === this.#active) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  /** 关掉全部对话（进程退出时用） */
  async closeAll(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  #metaFile(dir: string): string {
    return path.join(dir, 'meta.json');
  }

  #readMeta(dir: string, id: string): Meta {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#metaFile(dir), 'utf8')) as Partial<Meta>;
      return {
        id,
        title: typeof parsed.title === 'string' && parsed.title !== '' ? parsed.title : id,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      };
    } catch {
      return { id, title: id === DEFAULT_CONVERSATION_ID ? '默认对话' : id, createdAt: new Date().toISOString() };
    }
  }

  #writeMeta(dir: string, meta: Meta): void {
    try {
      fs.writeFileSync(this.#metaFile(dir), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    } catch {
      /* meta 写不出去不该让开对话失败 */
    }
  }
}
