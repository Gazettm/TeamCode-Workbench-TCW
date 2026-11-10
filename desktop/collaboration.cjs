const { createHash } = require('node:crypto');
const { validateServerUrl } = require('./core.cjs');

function endpoint(value) {
  const base = validateServerUrl(value);
  const url = new URL(base);
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('HTTP 仅支持本机地址；连接其他电脑或云端服务请使用 HTTPS。');
  }
  return base;
}

class SessionExpired extends Error {
  constructor() { super('登录已失效，请重新登录。'); this.code = 'SESSION_EXPIRED'; }
}

function text(value, max) {
  if (typeof value !== 'string' || !value || value.length > max) throw new Error('请检查输入内容。');
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new Error('项目或邀请编号不正确。');
  return value;
}
async function boundedJson(response) {
  if (!response.headers.get('content-type')?.includes('application/json') || !response.body) throw new Error('服务返回的格式不正确。');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('服务返回的数据过大。');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

class CollaborationClient {
  #session = null;
  #queue = Promise.resolve();

  constructor(store) { this.store = store; }

  serialize(action) {
    const task = this.#queue.then(action);
    this.#queue = task.catch(() => {});
    return task;
  }

  identity() {
    if (this.#session && this.#session.expires <= Date.now()) this.#session = null;
    if (!this.#session) return { scope: 'offline', user: null };
    const { base, user } = this.#session;
    const scope = createHash('sha256').update(base + '\0' + user.id).digest('hex');
    return { scope, user };
  }

  async #http(base, method, route, body, token) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    let response;
    try {
      response = await fetch(base + route, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(8000)
      });
    } catch {
      throw new Error('无法连接协作服务，请检查本地服务是否已启动、地址和网络是否正确。');
    }
    if (response.status === 204) return null;
    if (response.status === 401 && token) throw new SessionExpired();
    let result;
    try { result = await boundedJson(response); }
    catch { throw new Error('地址未返回有效的协作服务数据，请检查服务配置。'); }
    if (!response.ok) {
      const message = typeof result?.message === 'string' ? result.message.slice(0, 180) : '协作服务请求失败。';
      throw new Error(message);
    }
    return result;
  }

  async #logout() {
    const previous = this.#session;
    this.#session = null;
    if (!previous || previous.expires <= Date.now()) return { remote: true };
    try {
      await this.#http(previous.base, 'POST', '/api/auth/logout', undefined, previous.token);
      return { remote: true };
    } catch (error) { return { remote: error instanceof SessionExpired }; }
  }

  saveAddress(value) {
    return this.serialize(async () => {
      const base = endpoint(value);
      const settings = await this.store.update(data => {
        data.settings.serverUrl = base;
        return data.settings;
      });
      const logout = this.#session && this.#session.base !== base ? await this.#logout() : null;
      return { settings, logout };
    });
  }

  run(operation, input = {}) {
    return this.serialize(async () => {
      if (operation === 'logout') return this.#logout();
      const base = endpoint((await this.store.read()).settings.serverUrl);
      if (operation === 'health') {
        const result = await this.#http(base, 'GET', '/api/health');
        if (result?.service !== 'tcw-server' || result.status !== 'ready') throw new Error('此地址不是可用的协作工作台服务。');
        return result;
      }
      if (operation === 'register' || operation === 'login') {
        if (this.identity().user) throw new Error('请先退出当前账号。');
        const body = { username: text(input.username, 32).trim(), password: text(input.password, 72) };
        if (operation === 'register') body.displayName = text(input.displayName, 48).trim();
        const result = await this.#http(base, 'POST', '/api/auth/' + operation, body);
        if (operation === 'register') return result;
        const expires = Date.parse(result.expiresAt);
        if (!/^[a-zA-Z0-9_-]{43}$/.test(result.token || '') || !Number.isFinite(expires) || expires <= Date.now()
            || typeof result.user?.username !== 'string' || typeof result.user?.displayName !== 'string') {
          throw new Error('服务返回的登录结果不正确。');
        }
        const user = { id: id(result.user.id), username: result.user.username, displayName: result.user.displayName };
        this.#session = { base, token: result.token, expires, user };
        return this.identity();
      }
      if (!this.identity().user || this.#session.base !== base) {
        this.#session = null;
        throw new SessionExpired();
      }
      let route, method = 'GET', body;
      switch (operation) {
        case 'projects': route = '/api/projects'; break;
        case 'createProject': route = '/api/projects'; method = 'POST'; body = { name: text(input.name, 80).trim() }; break;
        case 'members': route = '/api/projects/' + id(input.projectId) + '/members'; break;
        case 'invitations': route = '/api/projects/' + id(input.projectId) + '/invitations'; break;
        case 'issue': {
          route = '/api/projects/' + id(input.projectId) + '/invitations'; method = 'POST';
          const validHours = input.validHours;
          if (!Number.isInteger(validHours) || validHours < 1 || validHours > 168) throw new Error('邀请码有效时间为 1–168 小时。');
          body = { validHours };
          break;
        }
        case 'revoke':
          route = '/api/projects/' + id(input.projectId) + '/invitations/' + id(input.invitationId); method = 'DELETE';
          break;
        case 'join': route = '/api/invitations/join'; method = 'POST'; body = { code: text(input.code, 128).trim() }; break;
        default: throw new Error('不支持该协作操作。');
      }
      try { return await this.#http(base, method, route, body, this.#session.token); }
      catch (error) {
        if (error instanceof SessionExpired) this.#session = null;
        throw error;
      }
    });
  }
}

module.exports = { CollaborationClient };
