const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);

function validateServerUrl(value) {
  if (typeof value !== 'string' || value.length > 500) throw new Error('请输入有效服务地址');
  let url;
  try { url = new URL(value); } catch { throw new Error('服务地址应包含 http:// 或 https://'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('仅支持不含账号、密码、查询参数的 HTTP(S) 服务地址');
  }
  return url.href.replace(/\/$/, '');
}

class Store {
  constructor(directory) { this.file = path.join(directory, 'state.json'); this.queue = Promise.resolve(); }
  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.schema !== 1 || !Array.isArray(data.workspaces) || !data.notes || !data.settings) throw new Error('数据结构不兼容');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return { schema: 1, settings: { serverUrl: 'http://localhost:8080' }, workspaces: [], notes: {} };
      throw new Error('本地数据读取失败，原文件已保留。请备份数据后检查 state.json。');
    }
  }
  update(change) {
    const task = this.queue.then(async () => {
      const data = await this.read();
      const result = await change(data);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      try { await fs.rename(temporary, this.file); } finally { await fs.rm(temporary, { force: true }); }
      return result;
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

async function git(args, cwd) {
  try {
    const result = await runFile('git', args, { cwd, windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
    return result.stdout.trim();
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('未检测到 Git，请安装 Git for Windows 后重新启动客户端');
    if (error.killed) throw new Error('Git 检查超时，请检查仓库后重试');
    if (error.stderr?.includes('dubious ownership')) throw new Error('Git 拒绝访问：仓库所有者与当前用户不同。请在外部确认目录归属，客户端不会自动修改信任设置。');
    throw new Error('Git 无法读取此目录，请确认它是可访问的工作仓库（可在终端运行 git status 检查）');
  }
}

async function inspectRepository(directory) {
  const root = await fs.realpath(directory);
  if (await git(['rev-parse', '--is-inside-work-tree'], root) !== 'true') throw new Error('请选择已有 Git 工作仓库');
  const top = await fs.realpath(await git(['rev-parse', '--show-toplevel'], root));
  const branch = await git(['branch', '--show-current'], top);
  const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], top);
  return { root: top, name: path.basename(top), branch: branch || '分离 HEAD', dirty: Boolean(status), gitVersion: await git(['--version'], top) };
}

async function resolveInside(root, relative = '') {
  if (typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\') || path.isAbsolute(relative) || relative.split('/').some(p => p === '..' || p.toLowerCase() === '.git')) throw new Error('不允许访问工作区外部或 Git 内部路径');
  const target = await fs.realpath(path.resolve(root, relative));
  const rel = path.relative(root, target);
  if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) throw new Error('路径超出当前工作区');
  return target;
}

async function listDirectory(root, relative) {
  const target = await resolveInside(root, relative);
  const items = (await fs.readdir(target, { withFileTypes: true })).filter(entry => entry.name.toLowerCase() !== '.git' && !entry.isSymbolicLink());
  items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'));
  return { truncated: items.length > 1000, entries: items.slice(0, 1000).map(entry => ({ name: entry.name, path: relative ? `${relative}/${entry.name}` : entry.name, directory: entry.isDirectory() })) };
}

class Workbench {
  constructor(store) { this.store = store; }
  async workspace(id) {
    const item = (await this.store.read()).workspaces.find(item => item.id === id);
    if (!item) throw new Error('工作区不存在，请重新导入');
    const root = await fs.realpath(item.root);
    if (root !== item.root) throw new Error('工作区路径已变化，请重新导入');
    return item;
  }
  async importDirectory(directory) {
    const repo = await inspectRepository(directory);
    return this.store.update(data => {
      const existing = data.workspaces.find(item => item.root.toLowerCase() === repo.root.toLowerCase());
      if (existing) return existing;
      const item = { id: crypto.randomUUID(), root: repo.root, name: repo.name };
      data.workspaces.push(item);
      return item;
    });
  }
  async list(id, relative = '') { return listDirectory((await this.workspace(id)).root, relative); }
  async status(id) { return inspectRepository((await this.workspace(id)).root); }
  async saveNote(id, relative, text) {
    const workspace = await this.workspace(id);
    await resolveInside(workspace.root, relative);
    if (!relative || typeof text !== 'string' || text.length > 4000) throw new Error('请选择文件或目录，备注最多 4000 字');
    await this.store.update(data => {
      const notes = data.notes[id] || (data.notes[id] = {});
      Object.defineProperty(notes, relative, { value: text, enumerable: true, configurable: true, writable: true });
    });
  }
}
module.exports = { Store, Workbench, validateServerUrl, inspectRepository, resolveInside, listDirectory };
