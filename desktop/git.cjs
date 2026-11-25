const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify, TextDecoder } = require('node:util');

const exec = promisify(execFile);
const queues = new Map();
const gitArgs = ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=false'];
const network = { timeout: 120000 };
const heads = 'refs/heads/';
const commitLimit = 100;

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|NAMESPACE|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|AUTHOR_.*|COMMITTER_.*|CONFIG_PARAMETERS|CONFIG_COUNT)$/i.test(key)) delete env[key];
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https:ssh:file', LC_ALL: 'C' };
}

function gitError(error) {
  const out = String(error.stderr || '');
  if (error.code === 'ENOENT') return new Error('未检测到 Git，请安装 Git for Windows 后重新启动客户端。');
  if (error.killed) return new Error('Git 操作超时，请检查连接和仓库状态后重试。');
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new Error('Git 输出过大，请在终端查看完整结果。');
  if (/dubious ownership/i.test(out)) return new Error('Git 拒绝访问，请在终端确认仓库的所有者和信任设置。');
  if (/GH006|GH013|protected branch|changes must be made through a pull request/i.test(out)) {
    return new Error('GitHub 分支规则拒绝了推送。请检查此分支是否要求通过 Pull Request 合并。');
  }
  if (/host key verification/i.test(out)) return Object.assign(new Error('无法验证 SSH 主机。请核对 GitHub 的主机指纹及本机 SSH 配置。'), { code: 'GIT_AUTH' });
  if (/authentication|publickey|repository not found|terminal prompts disabled|could not read (username|password)|permission.*denied|requested URL returned error: (401|403)/i.test(out)) {
    return Object.assign(new Error('无法读取或写入远程仓库。请检查仓库地址、账号权限及本机 GitHub 授权。'), { code: 'GIT_AUTH' });
  }
  if (/non-fast-forward|fetch first|stale info|failed to push/i.test(out)) return new Error('远程拒绝推送，请获取远程状态，并检查分支是否落后或被保护。');
  if (/could not resolve|failed to connect|timed out|could not read from remote/i.test(out)) return new Error('无法连接远程仓库，请检查地址、网络和 Git 认证。');
  if (/index.lock|another git process/i.test(out)) return new Error('仓库正被其他 Git 操作占用，请等它完成后重试。');
  if (/not fully merged/i.test(out)) return new Error('Git 判定此分支尚未合并，已保留分支。确认无需这段历史后，可选择「强制删除」。');
  if (/cannot delete branch.+used by worktree|cannot delete branch.+checked out/i.test(out)) return new Error('此分支正在工作区中使用。请先切换分支后再删除。');
  if (/couldn't find remote ref/i.test(out)) return new Error('远程分支已不存在，请检查当前分支的上游设置。');
  if (/nothing to commit|no changes added/i.test(out)) return new Error('选中的文件已没有可提交的改动，请刷新。');
  if (/would be overwritten|not possible to fast-forward|not uptodate|not up to date/i.test(out)) return new Error('Git 无法安全更新工作区，请先处理可能被覆盖的本地文件。');
  return new Error('Git 操作失败。请用终端查看对应 Git 命令的详细输出。');
}

async function git(root, args, options = {}) {
  try {
    return (await exec('git', [...gitArgs, ...args], {
      cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: gitEnvironment(), ...options
    })).stdout;
  } catch (error) {
    if (options.allowExit != null && options.allowExit === error.code) return error.stdout || '';
    throw gitError(error);
  }
}

function locked(root, work) {
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  if (queues.has(key)) throw new Error('此仓库已有 Git 操作正在进行。');
  const task = Promise.resolve().then(work);
  queues.set(key, task);
  return task.finally(() => queues.delete(key));
}

const value = async (root, args, options) => (await git(root, args, options)).trim();
const optional = { allowExit: 1 };
const nul = data => data.split('\0').filter(Boolean);

async function authorField(root, key) {
  const result = await git(root, ['config', '--show-scope', '--get', key], optional);
  const end = result.indexOf('\t');
  return end < 0 ? { value: '', scope: '' } : { value: result.slice(end + 1).trim(), scope: result.slice(0, end) };
}

function checkedAuthor(input) {
  if (typeof input.name !== 'string' || typeof input.email !== 'string' || !input.name.trim() || input.name.length > 100 ||
      /[\u0000-\u001f<>]/.test(input.name) || input.email.length > 200 || !/^[^\s<>@]+@[^\s<>@]+$/.test(input.email)) {
    throw new Error('请填写有效的 Git 姓名和邮箱。');
  }
  return [input.name.trim(), input.email];
}

async function setAuthor(root, scope, input) {
  const [name, email] = checkedAuthor(input);
  await git(root, ['config', scope, '--replace-all', '--', 'user.name', name]);
  await git(root, ['config', scope, '--replace-all', '--', 'user.email', email]);
}

async function projectRoot(root) {
  const top = await value(root, ['rev-parse', '--show-toplevel']);
  if (await fs.realpath(top) !== root) throw new Error('仓库根目录已变化，请重新导入。');
}

async function readGit(root) {
  await projectRoot(root);
  const [branchRef, head, status, refs, markers, name, email, origin] = await Promise.all([
    value(root, ['symbolic-ref', '--quiet', 'HEAD'], optional),
    value(root, ['rev-parse', '--verify', 'HEAD'], { allowExit: 128 }),
    git(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']),
    value(root, ['for-each-ref', '--format=%(refname)%09%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)', heads]),
    value(root, ['rev-parse', '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD', '--git-path', 'sequencer']),
    authorField(root, 'user.name'),
    authorField(root, 'user.email'),
    value(root, ['remote'])
  ]);
  const branch = branchRef.startsWith(heads) ? branchRef.slice(heads.length) : '';
  const files = nul(status).map(line => {
    const file = line.slice(3);
    return { status: line.slice(0, 2), path: file, selectable: !file.endsWith('/') && !file.includes('\ufffd') };
  });
  const branchRows = refs ? refs.split(/\r?\n/).map(line => line.split('\t')) : [];
  const branches = branchRows.map(([ref]) => ref.slice(heads.length));
  const upstreamRow = branchRows.find(([ref]) => ref === branchRef);
  const upstream = upstreamRow?.[1] ? { ref: upstreamRow[1], remote: upstreamRow[2], destination: upstreamRow[3] } : null;
  const [ahead, behind] = head && upstream && await commitExists(root, upstream.ref)
    ? (await value(root, ['rev-list', '--left-right', '--count', 'HEAD...' + upstream.ref])).split(/\s+/).map(Number)
    : [null, null];
  let inProgress = files.some(file => /U|^AA$|^DD$/.test(file.status));
  for (const marker of markers.split(/\r?\n/).filter(Boolean)) {
    if (await fs.lstat(path.resolve(root, marker)).then(() => true, () => false)) {
      inProgress = true;
      break;
    }
  }
  const staged = files.some(file => file.status !== '??' && file.status[0] !== ' ');
  return { branch, head, files: files.slice(0, 1000), changeCount: files.length, commitLimit, dirty: files.length > 0, staged, truncated: files.length > 1000,
    branches, inProgress, upstream, ahead, behind, author: { name: name.value, email: email.value }, hasOrigin: origin.split(/\r?\n/).includes('origin') };
}

async function commitExists(root, ref) {
  return Boolean(await value(root, ['show-ref', '--verify', '--hash', ref], { allowExit: 128 }));
}

function requireBranch(info) {
  if (!info.branch || !info.head) throw new Error('请先切到已有提交的本地分支。');
}

function requireClean(info) {
  if (info.dirty) throw new Error('工作区有未提交改动，请先处理改动再继续。');
}

function sameHead(before, current) {
  if (before.branch !== current.branch || before.head !== current.head) throw new Error('分支或最新提交已变化，请刷新后重新确认。');
}

function requireIdle(info) {
  if (info.inProgress) throw new Error('仓库正在合并、变基或处理冲突，请先在终端完成当前操作。');
}

function selectedFiles(info, paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > commitLimit) throw new Error('每次请选择 1–' + commitLimit + ' 个文件。');
  const available = new Map(info.files.map(item => [item.path, item]));
  return [...new Set(paths)].map(file => {
    const item = available.get(file);
    if (!item?.selectable) throw new Error('文件不在当前改动列表中，或属于嵌套仓库。请刷新后重试。');
    return item;
  });
}

async function diff(root, file) {
  const [item] = selectedFiles(await readGit(root), [file]);
  if (item.status === '??') {
    const absolute = path.resolve(root, file);
    if (await fs.realpath(absolute) !== absolute) return '此新文件包含链接，无法在此预览。';
    const stats = await fs.lstat(absolute);
    if (!stats.isFile() || stats.size > 100000) return '此新文件无法在此预览。';
    const content = await fs.readFile(absolute);
    try {
      if (content.includes(0)) return '二进制文件';
      return new TextDecoder('utf-8', { fatal: true }).decode(content) || '空文件';
    } catch { return '此新文件无法以 UTF-8 文本预览。'; }
  }
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
  const [staged, unstaged] = await Promise.all([
    git(root, [...args, '--cached', '--', file]),
    git(root, [...args, '--', file])
  ]);
  return [staged && '已暂存\n' + staged, unstaged && '工作区\n' + unstaged].filter(Boolean).join('\n').slice(0, 100000) || '没有可显示的文本差异。';
}

function remoteDisplay(url) {
  if (!url || /[\u0000-\u001f]/.test(url)) throw new Error('远程地址无效。');
  if (/^https:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('远程地址包含凭据信息，请在终端配置干净的地址并使用 Git 凭据。');
    return parsed.href;
  }
  if (url.includes('://')) {
    const parsed = new URL(url);
    if (!['ssh:', 'file:'].includes(parsed.protocol) || parsed.password || parsed.search || parsed.hash) {
      throw new Error('请使用不含密码的 HTTPS、SSH 或本机路径。');
    }
  }
  return url;
}

function sshTarget(address) {
  if (address.startsWith('ssh://')) {
    const url = new URL(address);
    return { host: url.hostname, port: url.port, user: url.username };
  }
  const scp = /^(?:([\w.-]+)@)?([\w.-]+):[^\\]/.exec(address);
  return scp && scp[2].length > 1 ? { host: scp[2], user: scp[1] } : null;
}

async function configuredRemote(root, name) {
  if (!/^[a-zA-Z0-9][\w./-]*$/.test(name || '')) throw new Error('请选择仓库的远程地址。');
  const urls = (await value(root, ['remote', 'get-url', '--all', '--', name])).split(/\r?\n/);
  if (urls.length !== 1) throw new Error('此远程配置了多个地址，请在 Git 中核对。');
  const address = remoteDisplay(urls[0]);
  const protocol = address.startsWith('https://') && new URL(address).hostname === 'github.com' ? 'github-https' :
    sshTarget(address) ? 'ssh' : 'other';
  return { name, address, protocol };
}

async function gitSettings(root, base, operation, input = {}) {
  if (root) await projectRoot(root);
  if (operation === 'read') {
    const version = await value(base, ['--version']);
    const [manager, name, email] = await Promise.all([
      value(base, ['credential-manager', '--version']).catch(() => ''),
      value(base, ['config', '--global', '--get', 'user.name'], optional),
      value(base, ['config', '--global', '--get', 'user.email'], optional)
    ]);
    const accounts = manager ? await value(base, ['credential-manager', 'github', 'list', '--no-ui'])
      .then(list => list.split(/\r?\n/).map(line => line.trim()).filter(line => /^[a-z\d][a-z\d-]{0,38}$/i.test(line)))
      .catch(() => null) : null;
    const author = root ? { name: await authorField(root, 'user.name'), email: await authorField(root, 'user.email') } : null;
    const remotes = root ? await Promise.all((await value(root, ['remote'])).split(/\r?\n/).filter(Boolean).map(
      remote => configuredRemote(root, remote).catch(() => ({ name: remote, address: '', protocol: '' }))
    )) : [];
    return { version, manager, accounts, global: { name, email }, author, remotes };
  }
  if (operation === 'login') {
    await value(base, ['credential-manager', '--version']).catch(() => { throw new Error('请先安装 Git for Windows 中的 Git Credential Manager。'); });
    await git(base, ['credential-manager', 'github', 'login', '--browser'], { timeout: 300000 })
      .catch(() => { throw new Error('GitHub 授权未完成。请检查浏览器中的授权结果后重试。'); });
    return;
  }
  if (operation === 'save-global') return locked(base, () => setAuthor(base, '--global', input));
  if (!root) throw new Error('请先选择已导入的仓库。');
  if (operation === 'save-local') return locked(root, () => setAuthor(root, '--local', input));
  if (operation === 'inherit') {
    return locked(root, async () => {
      for (const key of ['user.name', 'user.email']) await git(root, ['config', '--local', '--unset-all', key], { allowExit: 5 });
    });
  }
  if (operation !== 'test' && operation !== 'ssh-identity') throw new Error('不支持该 Git 设置操作。');
  const remote = await configuredRemote(root, input.remote);
  if (operation === 'test') {
    await git(root, ['ls-remote', '--symref', '--', remote.name, 'HEAD'], {
      timeout: 20000, env: { ...gitEnvironment(), GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' }
    });
    return { protocol: remote.protocol };
  }
  const ssh = remote.protocol === 'ssh' && sshTarget(remote.address);
  if (!ssh || !/^[a-z\d][a-z\d._-]*$/i.test(ssh.host)) throw new Error('此远程地址无法用 OpenSSH 检测身份，请测试仓库读取权限。');
  if (process.env.GIT_SSH || process.env.GIT_SSH_COMMAND || await value(root, ['config', '--get', 'core.sshCommand'], optional)) {
    throw new Error('此仓库使用自定义 SSH 命令。请用「测试读取权限」按实际 Git 配置检查连接。');
  }
  const user = ssh.user || (['github.com', 'ssh.github.com'].includes(ssh.host.toLowerCase()) ? 'git' : null);
  const reply = await exec('ssh', ['-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oConnectTimeout=8',
    ...(ssh.port ? ['-p', ssh.port] : []), ...(user ? ['-l', user] : []), '--', ssh.host],
  { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 32768 }).catch(error => {
    if (error.stdout || error.stderr) return error;
    throw new Error('无法运行 OpenSSH，请检查 SSH 是否已安装。');
  });
  const output = (reply.stdout || '') + '\n' + (reply.stderr || '');
  const account = /^Hi ([a-z\d-]+)! You've successfully authenticated, but GitHub does not provide shell access\./im.exec(output)?.[1];
  if (!account) {
    if (/host key verification/i.test(output)) throw new Error('SSH 主机尚未通过验证，请核对 GitHub 主机指纹。');
    if (/permission denied/i.test(output)) throw new Error('SSH 密钥未通过认证，请检查本机密钥或 GitHub 授权。');
    throw new Error('无法确认 GitHub SSH 身份，请检查网络或 SSH 配置。');
  }
  return { account };
}

async function target(root, info, operation) {
  const remote = info.upstream?.remote || (info.hasOrigin && 'origin');
  if (!remote || remote === '.' || !/^[a-zA-Z0-9][\w./-]*$/.test(remote)) throw new Error('请先为当前分支配置可用的远程仓库。');
  const ref = info.upstream?.destination || heads + info.branch;
  if (!ref.startsWith(heads)) throw new Error('上游目标须为远程分支。');
  await git(root, ['check-ref-format', ref]);
  const urls = (await value(root, ['remote', 'get-url', ...(operation === 'push' ? ['--push'] : []), '--all', remote])).split(/\r?\n/);
  if (urls.length !== 1) throw new Error('此远程有多个地址，请在终端明确选择目标。');
  return { remote, ref, address: remoteDisplay(urls[0]) };
}

const titles = { author: '保存仓库作者', switch: '切换分支', createBranch: '创建并切换分支', commit: '本地提交',
  fetch: '获取远程状态', pull: '快进更新', push: '推送', align: '对齐到远程分支',
  deleteBranch: '删除本地分支', forceDeleteBranch: '强制删除本地分支' };

function requireNoStaged(info) {
  if (info.staged) throw new Error('对齐会重置暂存区。请先提交或取消暂存，再对齐分支。');
}

async function protectIgnoredFiles(root, from, to) {
  const [ignored, changed] = await Promise.all([
    git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory', '-z']),
    git(root, ['diff', '--name-only', '--no-renames', '--diff-filter=AMT', '-z', from, to, '--'])
  ]);
  const normalize = file => process.platform === 'win32' ? file.toLowerCase() : file;
  const paths = nul(ignored).map(normalize);
  for (const file of nul(changed)) {
    const name = normalize(file);
    let blocked = paths.some(entry => entry === name || entry.startsWith(name + '/') ||
      (!entry.endsWith('/') && name.startsWith(entry + '/')));
    if (!blocked && paths.some(entry => entry.endsWith('/') && name.startsWith(entry))) {
      blocked = await fs.lstat(path.join(root, file)).then(() => true, error => {
        if (error.code === 'ENOENT') return false;
        if (error.code === 'ENOTDIR') return true;
        throw error;
      });
    }
    if (blocked) throw new Error('对齐会覆盖被 Git 忽略的本地文件。请先处理：' + file);
  }
}

async function alignBranch(root, before, keepBackup, confirm) {
  requireBranch(before);
  requireNoStaged(before);
  const ref = before.upstream?.ref;
  if (!ref?.startsWith('refs/remotes/')) throw new Error('请先为当前分支设置远程上游。');
  const remote = await target(root, before, 'fetch');
  await git(root, ['fetch', '--no-tags', '--no-recurse-submodules', '--', remote.remote, '+' + remote.ref + ':' + ref], network);
  const fetched = await readGit(root);
  sameHead(before, fetched);
  requireIdle(fetched);
  if (fetched.upstream?.ref !== ref) throw new Error('远程目标已变化，请重新确认。');
  const targetHead = await value(root, ['rev-parse', '--verify', ref]);
  if (targetHead === before.head) return { canceled: false, alreadyAligned: true };
  const detail = [
    root,
    '本地 ' + before.branch + ' · ' + before.head.slice(0, 12),
    '远程 ' + remote.remote + '/' + remote.ref.slice(heads.length) + ' · ' + targetHead.slice(0, 12),
    '本地分支将指向上述远程提交。',
    keepBackup ? '原提交将保存在本地备份分支 tcw-backup-…。'
      : '本次不创建备份分支。当前分支独有的提交将从这条分支的历史中移除。',
    '未暂存的改动会尽量保留，遇到有改动的同一文件会停止。'
  ].join('\n');
  const decision = await confirm(titles.align, detail, { keepBackup });
  if (!decision) return { canceled: true };
  const backup = (typeof decision === 'object' ? decision.keepBackup === true : keepBackup)
    ? 'tcw-backup-' + new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + randomUUID().slice(0, 8)
    : null;
  const current = await readGit(root);
  sameHead(before, current);
  requireIdle(current);
  requireNoStaged(current);
  if (current.upstream?.ref !== ref || await value(root, ['rev-parse', '--verify', ref]) !== targetHead ||
      JSON.stringify(remote) !== JSON.stringify(await target(root, current, 'fetch'))) {
    throw new Error('远程目标已变化，请重新确认。');
  }
  await protectIgnoredFiles(root, current.head, targetHead);
  if (backup) await git(root, ['branch', '--no-track', '--', backup, current.head]);
  try {
    await git(root, ['reset', '--keep', '--no-recurse-submodules', targetHead]);
  } catch (error) {
    if (!backup) throw error;
    throw new Error(error.message + ' 原提交已保存在 ' + backup + '。');
  }
  return { canceled: false, backup };
}

async function operate(root, kind, input, confirm) {
  if (kind === 'read') return readGit(root);
  if (kind === 'diff') return diff(root, input.path);
  if (!Object.hasOwn(titles, kind)) throw new Error('不支持该 Git 操作。');
  const deleting = kind === 'deleteBranch' || kind === 'forceDeleteBranch';
  return locked(root, async () => {
    const before = await readGit(root);
    sameHead(input, before);
    requireIdle(before);
    if (kind === 'align') return alignBranch(root, before, input.keepBackup === true, confirm);
    let details = [];
    let destination;
    let deletedTip;
    if (kind === 'author') {
      details = checkedAuthor(input);
    } else if (kind === 'switch' || kind === 'createBranch' || deleting) {
      if (typeof input.target !== 'string' || !input.target || input.target.length > 240 || input.target.startsWith('-')) throw new Error('请输入有效的本地分支名。');
      await git(root, ['check-ref-format', heads + input.target]);
      if (before.branches.includes(input.target) !== (kind !== 'createBranch')) throw new Error('目标分支状态已变化，请刷新后重试。');
      details = ['目标分支 ' + input.target];
      if (deleting) {
        if (input.target === before.branch) throw new Error('请先切换分支，再删除当前分支。');
        deletedTip = await value(root, ['rev-parse', '--verify', heads + input.target]);
        details.push('分支提交 ' + deletedTip.slice(0, 12), '此操作删除本地分支。');
        if (kind === 'forceDeleteBranch') {
          details.push('将跳过已合并检查。仅由此分支保留的提交可能难以恢复。');
        }
      } else {
        if (!before.head) throw new Error('仓库需要先有一次提交。');
        if (kind === 'switch' && input.target !== before.branch) requireClean(before);
        if (kind === 'createBranch' && before.dirty) details.push('新分支从当前提交开始，未提交改动会保留。');
      }
    } else if (kind === 'commit') {
      if (!before.branch) throw new Error('请先切换到本地分支。');
      if (!before.author.name || !before.author.email) throw new Error('请先在设置中填写此仓库的 Git 作者姓名和邮箱。');
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 1000 || input.message.includes('\0')) throw new Error('请填写提交说明（最多 1000 字）。');
      details = [input.message.trim(), ...selectedFiles(before, input.paths).map(file => file.path)];
    } else {
      requireBranch(before);
      if (kind === 'pull') {
        requireClean(before);
        if (!before.upstream) throw new Error('当前分支没有上游，无法快进更新。');
      }
      if (kind === 'push' && before.behind > 0) throw new Error('当前分支落后于已知上游，请获取远程状态并检查能否快进。');
      destination = await target(root, before, kind);
      if (kind === 'push' && input.sameBranchRemote === true && destination.ref !== heads + before.branch) {
        throw new Error('此分支的上游与任务分支不同，请先核对远程配置。');
      }
      const remoteBranch = destination.remote + '/' + destination.ref.slice(heads.length);
      details = [kind === 'push' ? before.branch + ' → ' + remoteBranch :
        before.branch + ' ← ' + remoteBranch, destination.address];
    }
    if (kind !== 'fetch' && !await confirm(titles[kind], [root, '当前分支 ' + (before.branch || '分离 HEAD'), ...details].join('\n'))) return { canceled: true };
    const current = await readGit(root);
    sameHead(before, current);
    requireIdle(current);
    if (destination && JSON.stringify(destination) !== JSON.stringify(await target(root, current, kind))) throw new Error('远程目标已变化，请重新确认。');
    switch (kind) {
      case 'author':
        await setAuthor(root, '--local', input);
        break;
      case 'switch':
        if (input.target === current.branch) break;
        requireClean(current);
        await git(root, ['switch', '--no-guess', '--no-overwrite-ignore', input.target]);
        break;
      case 'createBranch':
        requireIdle(current);
        await git(root, ['switch', '--no-guess', '--no-overwrite-ignore', '-c', input.target, current.head]);
        break;
      case 'deleteBranch':
      case 'forceDeleteBranch':
        if (!current.branches.includes(input.target) || await value(root, ['rev-parse', '--verify', heads + input.target]) !== deletedTip) {
          throw new Error('待删除分支已变化，请刷新后重新确认。');
        }
        await git(root, ['branch', kind === 'forceDeleteBranch' ? '-D' : '-d', '--', input.target]);
        break;
      case 'commit': {
        const files = selectedFiles(current, input.paths);
        const added = files.filter(file => file.status === '??').map(file => file.path);
        const commandLength = files.reduce((length, file) => length + file.path.length + 3, input.message.length);
        if (commandLength > 20000) throw new Error('选中文件路径过长，请分批提交。');
        if (added.length) await git(root, ['add', '--intent-to-add', '--', ...added]);
        await git(root, ['commit', '--only', '-m', input.message.trim(), '--', ...files.map(file => file.path)], network);
        break;
      }
      case 'fetch':
        await git(root, ['fetch', '--no-tags', '--no-recurse-submodules', '--', destination.remote], network);
        break;
      case 'push':
        await git(root, ['push', '--no-follow-tags', '--recurse-submodules=no', ...(current.upstream ? [] : ['--set-upstream']),
          '--', destination.remote, 'refs/heads/' + current.branch + ':' + destination.ref], network);
        break;
      case 'pull': {
        requireClean(current);
        if (current.upstream?.ref !== before.upstream.ref) throw new Error('跟踪分支已变化，请重新确认。');
        await git(root, ['fetch', '--prune', '--no-tags', '--no-recurse-submodules', '--', destination.remote], network);
        const fetched = await readGit(root);
        sameHead(current, fetched);
        requireIdle(fetched);
        requireClean(fetched);
        if (fetched.upstream?.ref !== before.upstream.ref || fetched.behind === null) throw new Error('远程跟踪分支已不存在或无法确认。');
        if (fetched.ahead > 0 && fetched.behind > 0) throw new Error('本地和远程分支已分叉。要把当前分支对齐到远程，可在「更多」中选择「对齐到远程分支」。');
        if (fetched.behind > 0) {
          const tip = await value(root, ['rev-parse', '--verify', fetched.upstream.ref]);
          await git(root, ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', tip], network);
        }
        break;
      }
    }
    return { canceled: false };
  });
}

function githubAddress(input) {
  if (typeof input !== 'string') throw new Error('请输入 GitHub 仓库地址。');
  const match = /^(https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+)\/?$/i.exec(input.trim());
  if (!match) throw new Error('请输入 GitHub 仓库的 HTTPS 或 SSH 克隆地址。');
  const name = match[3].replace(/\.git$/i, '');
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !/[a-zA-Z0-9_-]$/.test(name) || /^(\.|\.\.|con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw new Error('仓库名称不能用作 Windows 目录名。');
  return { url: match[1] + match[2] + '/' + name + '.git', name };
}

async function cloneGithub(parent, address, signal, progress) {
  const { url, name } = githubAddress(address);
  if (signal.aborted) throw new Error('克隆已取消。');
  const destination = path.join(parent, name);
  if (await fs.lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    throw new Error('目标目录已经存在，请选择其他父目录。');
  }
  const staging = await fs.mkdtemp(path.join(parent, '.tcw-clone-'));
  const cloned = path.join(staging, 'repo');
  try {
    progress({ phase: '正在连接 GitHub' });
    if (signal.aborted) throw new Error('克隆已取消。');
    await new Promise((resolve, reject) => {
      const child = spawn('git', [...gitArgs, 'clone', '--progress', '--', url, cloned], {
        cwd: parent, windowsHide: true, env: gitEnvironment(), stdio: ['ignore', 'ignore', 'pipe']
      });
      const cancel = () => {
        if (!child.pid || child.exitCode !== null) return;
        if (process.platform === 'win32') {
          execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, error => {
            if (error && child.exitCode === null) child.kill();
          });
        } else child.kill();
      };
      signal.addEventListener('abort', cancel, { once: true });
      let error, tail = '', pending = '';
      child.stderr.setEncoding('utf8').on('data', chunk => {
        tail = (tail + chunk).slice(-4000);
        const lines = (pending + chunk).split(/[\r\n]/);
        pending = lines.pop().slice(-1000);
        for (const line of lines) {
          const match = /^(?:remote:\s*)?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s*(?:(\d+)%)?/.exec(line);
          if (match) progress({ phase: match[1], percent: match[2] === undefined ? null : Number(match[2]) });
        }
      });
      child.on('error', caught => { error = caught; });
      child.once('close', code => {
        signal.removeEventListener('abort', cancel);
        if (signal.aborted) reject(new Error('克隆已取消。'));
        else if (error || code !== 0) reject(gitError(error || { stderr: tail }));
        else resolve();
      });
    });
    if (signal.aborted) throw new Error('克隆已取消。');
    await fs.rename(cloned, destination).catch(error => {
      if (['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw new Error('无法放入目标目录，请检查目录是否已存在或权限是否足够。');
      throw error;
    });
    return destination;
  } finally {
    // Only remove the temporary directory created by this attempt.
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}

module.exports = { operate, githubAddress, cloneGithub, gitSettings };
