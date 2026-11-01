const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Store, Workbench, validateServerUrl, resolveInside, listDirectory } = require('../desktop/core.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tcw-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true });
  await fs.writeFile(path.join(repo, '相同名称.md'), 'example');
  return { root, repo };
}

test('导入真实仓库、幂等导入、读取空提交分支和脏状态', async t => {
  const { root, repo } = await fixture(t);
  const service = new Workbench(new Store(path.join(root, 'data')));
  const item = await service.importDirectory(repo);
  assert.equal((await service.importDirectory(repo)).id, item.id);
  const status = await service.status(item.id);
  assert.equal(status.branch, 'main'); assert.equal(status.dirty, true);
  assert.equal((await service.store.read()).workspaces.length, 1);
  assert.deepEqual((await service.list(item.id)).entries.map(e => e.name), ['相同名称.md']);
  await assert.rejects(service.importDirectory(root));
});

test('同名文件跨工作区隔离；重建 Store 后备注仍存在；不会写入仓库', async t => {
  const { root, repo } = await fixture(t);
  const second = path.join(root, 'second'); await fs.mkdir(second);
  execFileSync('git', ['init', second], { windowsHide: true });
  await fs.writeFile(path.join(second, '相同名称.md'), 'second');
  const storePath = path.join(root, 'data');
  const service = new Workbench(new Store(storePath));
  const a = await service.importDirectory(repo), b = await service.importDirectory(second);
  await service.saveNote(a.id, '相同名称.md', '第一个仓库');
  await service.saveNote(b.id, '相同名称.md', '第二个仓库');
  const data = await new Store(storePath).read();
  assert.equal(data.notes[a.id]['相同名称.md'], '第一个仓库');
  assert.equal(data.notes[b.id]['相同名称.md'], '第二个仓库');
  assert.equal(await fs.readFile(path.join(repo, '相同名称.md'), 'utf8'), 'example');
  await fs.rename(path.join(repo, '相同名称.md'), path.join(repo, 'new.md'));
  assert.equal((await service.store.read()).notes[a.id]['new.md'], undefined);
  await assert.rejects(service.saveNote(a.id, '相同名称.md', '不能保存到失效路径'));
});

test('阻止目录越界、.git 内部、绝对路径、目录链接越界', async t => {
  const { root, repo } = await fixture(t);
  for (const value of ['../secret', '.git/config', 'x/../secret', 'C:\\Windows', 'x\\y']) await assert.rejects(resolveInside(repo, value));
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(repo, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveInside(repo, 'link'));
  assert.equal((await listDirectory(repo, '')).entries.some(item => item.name === 'link'), false);
});

test('并发写入保留所有变更，损坏数据不被静默覆盖', async t => {
  const { root } = await fixture(t);
  const store = new Store(path.join(root, 'data'));
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(data => { data.notes[`note${i}`] = 'ok'; })));
  assert.equal(Object.keys((await store.read()).notes).length, 20);
  await fs.writeFile(store.file, 'broken-json');
  await assert.rejects(store.update(data => { data.notes = {}; }), /原文件已保留/);
  assert.equal(await fs.readFile(store.file, 'utf8'), 'broken-json');
});

test('设置拒绝凭据、非 HTTP 协议和无效地址', () => {
  assert.equal(validateServerUrl('http://localhost:8080/'), 'http://localhost:8080');
  for (const value of ['bad', 'file:///etc', 'https://name:password@example.com', 'https://example.com/?key=secret']) assert.throws(() => validateServerUrl(value));
});
