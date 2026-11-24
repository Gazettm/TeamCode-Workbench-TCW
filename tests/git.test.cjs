const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { Store, Workbench } = require('../desktop/core.cjs');
const { randomUUID } = require('node:crypto');
const { operate, githubAddress, cloneGithub } = require('../desktop/git.cjs');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const read = root => operate(root, 'read');
const write = async (root, action, input = {}, confirm = () => true) =>
  operate(root, action, { ...await read(root), ...input }, confirm);

test('选择提交、保留无关暂存，分支切换和远程更新遵守安全条件', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcw-git-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  await fs.mkdir(path.join(dir, 'work'));
  const root = await fs.realpath(path.join(dir, 'work'));
  const file = (name, content) => fs.writeFile(path.join(root, name), content);
  git(dir, 'init', '--bare', '-b', 'main', 'remote.git');
  git(root, 'init', '-b', 'main');
  await write(root, 'author', { name: '测试作者', email: 'tcw@example.test' });
  assert.deepEqual((await read(root)).author, { name: '测试作者', email: 'tcw@example.test' });
  await file('README.md', 'origin\n');
  await file('other.txt', 'initial\n');
  await file('excluded.txt', 'excluded\n');
  git(root, 'add', '--', 'excluded.txt');
  await write(root, 'commit', { message: 'first', paths: ['README.md', 'other.txt'] });
  assert.deepEqual(git(root, 'show', '--format=', '--name-only', 'HEAD').split(/\r?\n/), ['README.md', 'other.txt']);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'excluded.txt');
  await write(root, 'commit', { message: 'include staged file', paths: ['excluded.txt'] });
  git(root, 'remote', 'add', 'origin', path.join(dir, 'remote.git'));
  await write(root, 'push');
  assert.equal((await read(root)).upstream.destination, 'refs/heads/main');
  await file('new-untracked.txt', 'untracked file');
  const dirty = await read(root);
  assert.equal(dirty.changeCount, 1);
  assert.deepEqual(dirty.files, [{ status: '??', path: 'new-untracked.txt', selectable: true }]);
  assert.deepEqual([dirty.ahead, dirty.behind], [0, 0]);
  await fs.unlink(path.join(root, 'new-untracked.txt'));

  const mainBeforeBranch = git(root, 'rev-parse', 'refs/heads/main');
  await write(root, 'createBranch', { target: 'task/sample' });
  assert.equal(git(root, 'rev-parse', 'refs/heads/main'), mainBeforeBranch);
  const store = new Store(path.join(dir, 'settings'));
  const workbench = new Workbench(store);
  const workspace = await workbench.importDirectory(root);
  const project = randomUUID(), task = randomUUID();
  await workbench.bind(project, workspace.id, null, null);
  await workbench.bind(project, workspace.id, task, 'task/sample');
  assert.equal((await store.read()).gitBindings[project].branches[task], 'task/sample');
  assert.deepEqual(await write(root, 'switch', { target: 'main' }, () => false), { canceled: true });
  assert.equal((await read(root)).branch, 'task/sample');
  await file('README.md', 'chosen\n');
  await file('other.txt', 'excluded staged change\n');
  git(root, 'add', '--', 'other.txt');
  await file('new file.txt', 'new text\n');
  assert.match(await operate(root, 'diff', { path: 'README.md' }), /chosen/);
  assert.match(await operate(root, 'diff', { path: 'new file.txt' }), /new text/);
  await assert.rejects(write(root, 'switch', { target: 'main' }), /未提交/);
  await assert.rejects(write(root, 'commit', { message: 'invalid', paths: ['.'] }), /改动列表/);
  await write(root, 'commit', { message: 'only selected', paths: ['README.md', 'new file.txt'] });
  assert.deepEqual(git(root, 'show', '--format=', '--name-only', 'HEAD').split(/\r?\n/), ['README.md', 'new file.txt']);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'other.txt');
  await write(root, 'push');
  assert.equal(git(dir, '--git-dir=remote.git', 'rev-parse', 'refs/heads/task/sample'), (await read(root)).head);

  await write(root, 'commit', { message: 'finish selected changes', paths: ['other.txt'] });
  await write(root, 'switch', { target: 'main' });
  assert.equal(git(root, 'rev-parse', 'HEAD'), mainBeforeBranch);
  git(dir, 'clone', 'remote.git', 'peer');
  const peer = path.join(dir, 'peer');
  git(peer, 'merge', '--squash', 'origin/task/sample');
  await fs.writeFile(path.join(peer, 'README.md'), 'from peer\n');
  git(peer, '-c', 'user.name=Peer', '-c', 'user.email=peer@example.test', 'commit', '-am', 'remote update');
  git(peer, 'push');
  await write(root, 'fetch');
  const afterSquash = await read(root);
  assert.deepEqual([afterSquash.ahead, afterSquash.behind], [0, 1]);
  await assert.rejects(write(root, 'push'), /落后/);
  await write(root, 'pull');
  assert.equal((await fs.readFile(path.join(root, 'README.md'), 'utf8')).trimEnd(), 'from peer');
  await file('README.md', 'local edit\n');
  await assert.rejects(write(root, 'pull'), /未提交/);
  await write(root, 'commit', { message: 'local edit', paths: ['README.md'] });
  await fs.writeFile(path.join(peer, 'README.md'), 'other remote edit\n');
  git(peer, '-c', 'user.name=Peer', '-c', 'user.email=peer@example.test', 'commit', '-am', 'second remote update');
  git(peer, 'push');
  await assert.rejects(write(root, 'pull'), /已分叉/);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'local edit\n');
});

test('克隆使用临时目录，成功后导入目标，拒绝覆盖并可取消', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcw-clone-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  const config = path.join(dir, 'gitconfig');
  const previousConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousConfig;
  });
  git(dir, 'init', '-b', 'main', 'fixture');
  const fixture = path.join(dir, 'fixture');
  await fs.writeFile(path.join(fixture, 'README.md'), 'sample');
  git(fixture, 'add', 'README.md');
  git(fixture, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'initial');
  const address = 'https://github.com/team/workbench.git';
  git(dir, 'config', '--file', config, 'url.' + fixture.replaceAll('\\', '/') + '.insteadOf', address);
  const controller = new AbortController();
  const progress = [];
  const output = await cloneGithub(dir, address, controller.signal, event => progress.push(event));
  assert.equal(path.basename(output), 'workbench');
  assert.equal(await fs.readFile(path.join(output, 'README.md'), 'utf8'), 'sample');
  assert.ok(progress.length);
  await assert.rejects(cloneGithub(dir, address, controller.signal, () => {}), /已经存在/);
  const cancelAddress = 'https://github.com/team/cancel.git';
  git(dir, 'config', '--file', config, '--add', 'url.' + fixture.replaceAll('\\', '/') + '.insteadOf', cancelAddress);
  const cancel = new AbortController();
  await assert.rejects(cloneGithub(dir, cancelAddress, cancel.signal, () => cancel.abort()), /取消/);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['fixture', 'gitconfig', 'workbench']);
});

test('对齐分叉默认不备份并可手动保留备份，删除本地分支遵守保护条件', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tcw-align-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  git(dir, 'init', '--bare', '-b', 'main', 'remote.git');
  git(dir, 'clone', 'remote.git', 'work');
  const root = await fs.realpath(path.join(dir, 'work'));
  const file = (name, content) => fs.writeFile(path.join(root, name), content);
  const commit = (cwd, message) => git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', message);
  await file('README.md', 'base\n');
  await file('note.txt', 'base note\n');
  git(root, 'add', '.');
  commit(root, 'base');
  git(root, 'push', 'origin', 'main');
  git(dir, 'clone', 'remote.git', 'peer');
  const peer = path.join(dir, 'peer');

  await file('README.md', 'local version\n');
  git(root, 'add', 'README.md');
  commit(root, 'original version');
  const original = git(root, 'rev-parse', 'HEAD');
  git(root, 'branch', 'not-yet-merged');
  await fs.writeFile(path.join(peer, 'README.md'), 'remote version\n');
  await fs.writeFile(path.join(peer, 'workspace.local'), 'remote settings\n');
  git(peer, 'add', '.');
  commit(peer, 'remote update');
  git(peer, 'push');

  const canceled = await write(root, 'align', { keepBackup: true }, (message, detail) => {
    assert.equal(message, '对齐到远程分支');
    assert.match(detail, /远程 origin\/main/);
    assert.match(detail, /本地备份分支 tcw-backup-/);
    return false;
  });
  assert.deepEqual(canceled, { canceled: true });
  assert.equal(git(root, 'rev-parse', 'HEAD'), original);
  assert.ok(!(await read(root)).branches.some(name => name.startsWith('tcw-backup-')));

  await file('note.txt', 'keep this edit\n');
  git(root, 'add', 'note.txt');
  await assert.rejects(write(root, 'align'), /暂存区/);
  assert.equal(git(root, 'diff', '--cached', '--name-only'), 'note.txt');
  git(root, 'restore', '--staged', 'note.txt');

  await file('README.md', 'conflicting working copy\n');
  await assert.rejects(write(root, 'align'), /本地文件/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), original);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'conflicting working copy\n');
  git(root, 'restore', 'README.md');

  await fs.appendFile(path.join(root, '.git', 'info', 'exclude'), '\nworkspace.local\n');
  await file('workspace.local', 'ignored local settings\n');
  await assert.rejects(write(root, 'align'), /本地文件/);
  assert.equal(await fs.readFile(path.join(root, 'workspace.local'), 'utf8'), 'ignored local settings\n');
  await fs.rename(path.join(root, 'workspace.local'), path.join(dir, 'workspace.local'));

  const aligned = await write(root, 'align', {}, (_message, detail) => {
    assert.match(detail, /本次不创建备份分支/);
    return true;
  });
  assert.deepEqual(aligned, { canceled: false, backup: null });
  const info = await read(root);
  assert.deepEqual([info.ahead, info.behind], [0, 0]);
  assert.ok(!info.branches.some(name => name.startsWith('tcw-backup-')));
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'keep this edit\n');
  assert.deepEqual(await write(root, 'align', { keepBackup: true }), { canceled: false, alreadyAligned: true });
  assert.equal(git(root, 'for-each-ref', 'refs/heads/tcw-backup-*'), '');

  git(root, 'reset', '--keep', original);
  const withBackup = await write(root, 'align', { keepBackup: true });
  assert.match(withBackup.backup, /^tcw-backup-/);
  assert.equal(git(root, 'rev-parse', withBackup.backup), original);
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'keep this edit\n');

  await assert.rejects(write(root, 'deleteBranch', { target: 'main' }), /当前分支/);
  await assert.rejects(write(root, 'deleteBranch', { target: 'not-yet-merged' }), /尚未合并/);
  git(root, 'branch', 'already-merged');
  assert.deepEqual(await write(root, 'deleteBranch', { target: 'already-merged' }, () => false), { canceled: true });
  await write(root, 'deleteBranch', { target: 'already-merged' });
  assert.ok(!(await read(root)).branches.includes('already-merged'));
  assert.ok((await read(root)).branches.includes('not-yet-merged'));

  const target = { target: 'not-yet-merged' };
  await assert.rejects(write(root, 'forceDeleteBranch', { target: 'main' }), /当前分支/);
  const canceledRemoval = await write(root, 'forceDeleteBranch', target, (title, detail) => {
    assert.equal(title, '强制删除本地分支');
    assert.match(detail, /not-yet-merged/);
    assert.ok(detail.includes(original.slice(0, 12)));
    assert.match(detail, /跳过已合并检查/);
    return false;
  });
  assert.deepEqual(canceledRemoval, { canceled: true });
  assert.ok((await read(root)).branches.includes(target.target));
  const linked = path.join(dir, 'linked');
  git(root, 'worktree', 'add', linked, target.target);
  await assert.rejects(write(root, 'forceDeleteBranch', target), /工作区中使用/);
  git(linked, 'switch', '--detach');
  const remoteBefore = git(dir, '--git-dir=remote.git', 'show-ref');
  await write(root, 'forceDeleteBranch', target);
  assert.ok(!(await read(root)).branches.includes(target.target));
  assert.equal(git(dir, '--git-dir=remote.git', 'show-ref'), remoteBefore);
});

test('克隆地址接受 GitHub HTTPS 和 SSH，拒绝凭据和非法路径', () => {
  assert.deepEqual(githubAddress('https://github.com/team/workbench/'), {
    url: 'https://github.com/team/workbench.git', name: 'workbench'
  });
  assert.equal(githubAddress('git@github.com:team/workbench.git').name, 'workbench');
  for (const url of ['https://secret@github.com/team/workbench', 'file:///repo', 'https://github.com/team/..', 'https://github.com/team/CON.git']) {
    assert.throws(() => githubAddress(url));
  }
});
