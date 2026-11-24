const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const { Store, Workbench } = require('./core.cjs');
const { CollaborationClient } = require('./collaboration.cjs');
const { cloneGithub, githubAddress } = require('./git.cjs');
const smoke = process.argv.includes('--smoke');
if (!smoke && !app.requestSingleInstanceLock()) app.exit(0);
if (smoke) app.setPath('userData', path.join(app.getPath('temp'), `tcw-smoke-${process.pid}`));
let window;
app.whenReady().then(async () => {
  const dataPath = app.getPath('userData');
  const store = new Store(dataPath);
  const collaboration = new CollaborationClient(store);
  const stores = new Map([['offline', store]]);
  let clone;
  let closeAfterClone = false;
  let smokeRepository;
  function localStore(scope) {
    if (!stores.has(scope)) stores.set(scope, new Store(path.join(dataPath, 'accounts', scope)));
    return stores.get(scope);
  }
  function workbench(scope) {
    if (scope !== collaboration.identity().scope) {
      const error = new Error('当前账号已切换或登录失效，请重新选择工作区。');
      error.code = 'SCOPE_CHANGED';
      throw error;
    }
    return new Workbench(localStore(scope));
  }
  if (smoke) {
    const fixture = path.join(app.getPath('userData'), '演示仓库');
    smokeRepository = fixture;
    await fs.mkdir(fixture, { recursive: true });
    await exec('git', ['init', '-b', 'main', fixture], { windowsHide: true });
    await fs.writeFile(path.join(fixture, 'README.md'), '# TCW smoke fixture');
    await fs.writeFile(path.join(fixture, 'second.txt'), 'Another change to select');
    await workbench('offline').importDirectory(fixture);
  }
  const handle = (name, fn) => ipcMain.handle(name, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: '请求来源无效' };
    try { return { ok: true, data: await fn(...args) }; }
    catch (error) { return { ok: false, error: error.message || '操作失败，请重试', code: error.code }; }
  });
  handle('bootstrap', async () => {
    const identity = collaboration.identity();
    const local = localStore(identity.scope);
    const { workspaces, notes, gitBindings = {} } = await local.read();
    const { settings } = await store.read();
    if (identity.scope !== collaboration.identity().scope) throw new Error('登录状态已变化，请重试。');
    return { workspaces, notes, gitBindings, settings, ...identity, version: app.getVersion(), dataPath: path.dirname(local.file) };
  });
  handle('workspace:import', async scope => {
    workbench(scope);
    if (smokeRepository) return workbench(scope).importDirectory(smokeRepository);
    const result = await dialog.showOpenDialog(window, { title: '选择已有 Git 仓库', properties: ['openDirectory'] });
    return result.canceled ? null : workbench(scope).importDirectory(result.filePaths[0]);
  });
  handle('workspace:list', (scope, id, relative) => workbench(scope).list(id, relative));
  handle('workspace:status', (scope, id) => workbench(scope).status(id));
  handle('workspace:git', (scope, id, operation, input) => workbench(scope).git(id, operation, input, async (message, detail) => {
    const result = smoke ? { response: 1 } : await dialog.showMessageBox(window, {
      type: 'question', message, detail, buttons: ['取消', '确认'], defaultId: 0, cancelId: 0, noLink: true
    });
    workbench(scope);
    return result.response === 1;
  }));
  handle('workspace:bind', (scope, projectId, workspaceId, taskId, branch) => {
    if (scope === 'offline') throw new Error('请先登录协作账号。');
    return workbench(scope).bind(projectId, workspaceId, taskId, branch);
  });
  handle('workspace:clone', async (scope, address) => {
    workbench(scope);
    const { name, url } = githubAddress(address);
    if (clone) throw new Error('已有克隆操作，请先等待或取消。');
    clone = new AbortController();
    const timer = setTimeout(() => clone.abort(), 600000);
    try {
      const picked = await dialog.showOpenDialog(window, { title: '选择克隆仓库的父目录', properties: ['openDirectory'] });
      if (picked.canceled) return null;
      const parent = await fs.realpath(picked.filePaths[0]);
      const result = await dialog.showMessageBox(window, { type: 'question', message: '克隆 GitHub 仓库',
        detail: url + '\n' + path.join(parent, name), buttons: ['取消', '确认克隆'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response === 0 || clone.signal.aborted) return null;
      workbench(scope);
      const directory = await cloneGithub(parent, address, clone.signal, progress => {
        if (window && !window.isDestroyed()) window.webContents.send('workspace:clone-progress', progress);
      });
      return workbench(scope).importDirectory(directory);
    } finally {
      clearTimeout(timer);
      clone = null;
      if (closeAfterClone && window && !window.isDestroyed()) {
        closeAfterClone = false;
        window.close();
      }
    }
  });
  handle('workspace:cancel-clone', () => { clone?.abort(); });
  handle('note:save', (scope, id, relative, text) => workbench(scope).saveNote(id, relative, text));
  handle('settings:save', serverUrl => collaboration.saveAddress(serverUrl));
  handle('collaboration', (operation, input) => collaboration.run(operation, input));
  window = new BrowserWindow({ width: 1280, height: 840, minWidth: 960, minHeight: 640, title: '协作工作台', backgroundColor: '#f5f7fb', show: !smoke, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => {
    if (!clone) return;
    event.preventDefault();
    closeAfterClone = true;
    clone.abort();
  });
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['继续编辑', '放弃修改并退出'], defaultId: 0, cancelId: 0, message: '个人备注尚未保存', detail: '退出会丢失本次未保存的备注修改。' });
    if (choice === 1) event.preventDefault();
  });
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  await window.loadFile(path.join(__dirname, '../dist/index.html'));
  if (smoke) {
    try {
      const testService = process.env.TCW_SMOKE_SERVER_URL || 'http://localhost:9090';
      if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d{4,5}$/.test(testService)) throw new Error('Smoke server must be a dedicated loopback endpoint');
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { let n=0; const t=setInterval(()=>{ if(document.querySelector('[data-ready="true"]')) {clearInterval(t);resolve(true)} else if(++n>100) {clearInterval(t);reject(new Error('页面初始化超时'))}},50) })`);
      const evidence = await window.webContents.executeJavaScript(`({title:document.title, text:document.body.innerText, bridge:typeof window.tcw?.bootstrap, node:typeof require})`);
      if (!evidence.text.includes('本地工作区') || evidence.bridge !== 'function' || evidence.node !== 'undefined') throw new Error('页面或隔离检查失败');
      await window.webContents.executeJavaScript(`(async()=>{
        const wait = async(test)=>{ for(let n=0;n<100;n++){if(test())return;await new Promise(r=>setTimeout(r,50))}throw new Error('交互等待超时') };
        const select=document.querySelector('select');select.value=select.options[1].value;select.dispatchEvent(new Event('change',{bubbles:true}));
        await wait(()=>document.querySelector('.file-row'));
        document.querySelector('.file-row').click();await wait(()=>document.querySelector('textarea'));
        const note=document.querySelector('textarea');note.value='启动说明与接口约定，修改前先阅读。';note.dispatchEvent(new Event('input',{bubbles:true}));
        await wait(()=>!document.querySelector('.note-footer button').disabled);document.querySelector('.note-footer button').click();
        await wait(()=>document.querySelector('.success')?.textContent.includes('备注已保存'));
        return true;
      })()`);
      const persisted = await store.read();
      if (!Object.values(persisted.notes)[0]?.['README.md']) throw new Error('UI 备注未持久化');
      await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const sizes = await window.webContents.executeJavaScript(`({ name: getComputedStyle(document.querySelector('.file-name')).fontSize, note: getComputedStyle(document.querySelector('.file-name small')).fontSize, editor: getComputedStyle(document.querySelector('.note-pane textarea')).fontSize })`);
      if (sizes.name !== '16px' || sizes.note !== '16px' || sizes.editor !== '16px') throw new Error('文件名或备注字号不符合 0.2 界面预期');
      await fs.mkdir('test-results', { recursive: true });
      await fs.writeFile('test-results/desktop.png', (await window.webContents.capturePage()).toPNG());
      const layouts = {};
      async function captureLayout(name, selector) {
        layouts[name] = {};
        for (const [size, width, height] of [['wide', 1280, 800], ['compact', 960, 640]]) {
          window.setContentSize(width, height);
          const metrics = await window.webContents.executeJavaScript(`(async()=>{
            const target=document.querySelector(${JSON.stringify(selector)});
            if(!target || !target.getClientRects().length)throw new Error('布局测试目标不可见');
            for(let n=0;n<90 && Math.abs(innerWidth-${width})>8;n++)await new Promise(resolve=>setTimeout(resolve,50));
            window.scrollTo(0,0);
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,columns:getComputedStyle(target).gridTemplateColumns};
          })()`);
          if (Math.abs(metrics.width - width) > 8 || metrics.documentWidth > metrics.width + 1) {
            throw new Error('页面布局超出窗口 ' + name + ' ' + size + ' ' + JSON.stringify(metrics));
          }
          layouts[name][size] = metrics;
          await fs.writeFile('test-results/' + app.getVersion().replaceAll('.', '') + '-' + name + '-' + size + '.png', (await window.webContents.capturePage()).toPNG());
        }
        window.setContentSize(1280, 800);
      }
      await captureLayout('files', '.explorer');
      evidence.text = await window.webContents.executeJavaScript('document.body.innerText');
      await window.webContents.executeJavaScript(`(async()=>{
        document.querySelectorAll('.sidebar-bottom .nav')[0].click();
        await new Promise(r=>setTimeout(r,100));
        const input=document.querySelector('#server');input.value=${JSON.stringify(testService)};input.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(r=>setTimeout(r,50));document.querySelector('.settings .primary').click();
        for(let i=0;i<100;i++){if(document.querySelector('.success')?.textContent.includes('设置已保存'))return;await new Promise(r=>setTimeout(r,50))}throw new Error('设置保存失败');
      })()`);
      if ((await store.read()).settings.serverUrl !== testService) throw new Error('设置未持久化');
      await captureLayout('settings', '.settings-layout');
      await window.webContents.executeJavaScript(`(async()=>{
        const nav=document.querySelector('.sidebar .nav');
        for(let i=0;i<120;i++){
          const tab=document.querySelector('#git-view');
          if(tab&&!tab.disabled){tab.click();break}
          if(!tab)nav.click();
          await new Promise(r=>setTimeout(r,50));
        }
        for(let i=0;i<120;i++){
          const file=document.querySelector('.git-files .diff-choice');
          if(file&&!file.matches(':disabled')){file.click();break}
          await new Promise(r=>setTimeout(r,50));
        }
        for(let i=0;i<120;i++){
          if(document.querySelector('.diff-panel pre')?.textContent.includes('TCW smoke fixture'))return;
          await new Promise(r=>setTimeout(r,50));
        }
        throw new Error('Git 文件预览未显示');
      })()`);
      await captureLayout('git', '.git-review-layout');
      await window.webContents.executeJavaScript(`(async()=>{
        const wait = async (test, label) => {
          for (let n=0;n<140;n++) {
            if (test()) return;
            const error=document.querySelector('.git-panel .error, .git-author-editor .error');
            if(error)throw new Error(label+': '+error.textContent);
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          throw new Error(label+' 超时');
        };
        const edit=(input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}))};
        const button=(label)=>[...document.querySelectorAll('.git-panel button, .git-author-editor button')].find(b=>b.textContent.trim()===label);
        await wait(()=>button('全选')&&!button('全选').matches(':disabled'),'加载改动列表');
        if(document.querySelectorAll('.git-file-state[title="??"]').length!==2
          || document.querySelector('.git-file-state[title="??"]').textContent!=='未跟踪') throw new Error('未跟踪文件标签不正确');
        button('全选').click();
        await wait(()=>button('提交选中的 2 个文件'),'全选');
        if(!button('提交选中的 2 个文件').matches(':disabled') || !document.querySelector('#git-commit-hint')?.textContent.includes('Git 姓名和邮箱')) throw new Error('缺少 Git 作者提示');
        button('取消全选').click();
        await wait(()=>button('提交选中的 0 个文件') && !document.querySelector('.git-files input:checked'),'取消全选');
        button('配置 Git 作者').click();
        await wait(()=>document.querySelector('#author-name') && document.querySelector('#git-author-settings'),'加载 Git 作者');
        edit(document.querySelector('#author-name'),'演示作者');
        edit(document.querySelector('#author-email'),'tcw@example.test');
        await wait(()=>button('保存 Git 作者')&&!button('保存 Git 作者').disabled,'保存 Git 作者按钮');
        button('保存 Git 作者').click();
        await wait(()=>document.querySelector('.git-author-editor .success') && !button('保存 Git 作者').disabled,'保存 Git 作者');
        document.querySelector('.sidebar .nav').click();
        await wait(()=>button('全选')&&!button('全选').matches(':disabled'),'加载 Git 改动');
        button('全选').click();
        await wait(()=>button('提交选中的 2 个文件'),'重新全选');
        if(!button('提交选中的 2 个文件').matches(':disabled') || !document.querySelector('#git-commit-hint')?.textContent.includes('填写提交说明')) throw new Error('缺少提交说明提示');
        edit(document.querySelector('#commit-message'),'桌面提交验证');
        await wait(()=>!button('提交选中的 2 个文件').matches(':disabled'),'选择提交');
        button('提交选中的 2 个文件').click();
        await wait(()=>document.querySelector('.git-panel .success')?.textContent.includes('已创建'),'提交成功');
        document.querySelector('.branch-tools summary').click();
        const branch=document.querySelector('.git-controls input');
        edit(branch,'task/smoke');
        await wait(()=>!button('从当前提交创建').disabled,'创建分支按钮');
        button('从当前提交创建').click();
        await wait(()=>document.querySelector('#git-current-branch')?.textContent==='task/smoke'
          && !document.querySelector('.workspace-bar select')?.disabled,'切换到新分支');
      })()`);
      const fixtureGit = (...args) => exec('git', ['-C', smokeRepository, ...args], { windowsHide: true });
      const remote = path.join(dataPath, 'smoke-remote.git');
      const peer = path.join(dataPath, 'smoke-peer');
      await exec('git', ['init', '--bare', '-b', 'main', remote], { windowsHide: true });
      await fixtureGit('remote', 'add', 'origin', remote);
      await fixtureGit('push', 'origin', 'HEAD:refs/heads/main');
      await fixtureGit('branch', '--set-upstream-to=origin/main', 'task/smoke');
      await fixtureGit('branch', 'test/delete-after-merge');
      await exec('git', ['clone', remote, peer], { windowsHide: true });
      await fs.writeFile(path.join(peer, 'remote.txt'), 'Changes from remote');
      await exec('git', ['-C', peer, 'add', 'remote.txt'], { windowsHide: true });
      await exec('git', ['-C', peer, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'remote change'], { windowsHide: true });
      await exec('git', ['-C', peer, 'push'], { windowsHide: true });
      await fs.writeFile(path.join(smokeRepository, 'local.txt'), 'Changes from diverged local branch');
      await fixtureGit('add', 'local.txt');
      await fixtureGit('commit', '-m', 'diverged local change');
      const original = (await fixtureGit('rev-parse', 'HEAD')).stdout.trim();
      await window.webContents.executeJavaScript(`(async()=>{
        const refresh=[...document.querySelectorAll('.git-remote button')].find(button=>button.textContent.trim()==='刷新 Git 状态');
        refresh.click();
        for(let n=0;n<140;n++){
          const target=document.querySelector('#git-align-remote');
          if(target&&!target.disabled){document.querySelector('.git-more summary').click();return}
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        throw new Error('Git 更多菜单未读取上游');
      })()`);
      await captureLayout('git-more', '.git-more-panel');
      await window.webContents.executeJavaScript(`(async()=>{
        const wait=async (test,label)=>{
          for(let n=0;n<140;n++){
            if(test())return;
            const error=document.querySelector('.git-panel .error');
            if(error)throw new Error(label+': '+error.textContent);
            await new Promise(resolve=>setTimeout(resolve,50));
          }
          throw new Error(label+' 超时');
        };
        document.querySelector('#git-align-remote').click();
        await wait(()=>document.querySelector('.git-panel .success')?.textContent.includes('已对齐到远程分支')
          && !document.querySelector('.workspace-bar select')?.disabled,'对齐远程');
        document.querySelector('.git-more summary').click();
        document.querySelector('#git-show-delete').click();
        await wait(()=>document.querySelector('#git-branch-to-delete'),'选择要删除的分支');
        const picker=document.querySelector('#git-branch-to-delete');
        if([...picker.options].some(option=>option.value==='task/smoke'))throw new Error('当前分支出现在删除列表');
        picker.value='test/delete-after-merge';
        picker.dispatchEvent(new Event('change',{bubbles:true}));
        const button=document.querySelector('.git-delete-form button');
        await wait(()=>!button.disabled,'继续删除');
        button.click();
        await wait(()=>document.querySelector('.git-panel .success')?.textContent.includes('已删除本地分支')
          && !document.querySelector('.workspace-bar select')?.disabled,'删除本地分支');
      })()`);
      const after = await fixtureGit('for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/');
      if (!after.stdout.split(/\r?\n/).some(line => line.startsWith('tcw-backup-') && line.endsWith(original)) ||
          after.stdout.includes('test/delete-after-merge') ||
          (await fixtureGit('rev-list', '--left-right', '--count', 'HEAD...origin/main')).stdout.trim() !== '0\t0') {
        throw new Error('Git 对齐或删除操作结果未通过验证');
      }
      evidence.checks = ['Vue 加载', 'preload 桥接', 'Node 隔离', '仓库选择与文件展示', '页面备注保存', '页面设置保存'];
      evidence.git = { author: true, selectedCommit: true, branch: true, selectAll: true, commitHints: true, fileStatuses: true, align: true, deleteBranch: true };
      evidence.fontSizes = sizes;
      if (process.env.TCW_SMOKE_SERVER_URL) {
        evidence.collaboration = await require('./project-smoke.cjs').runProjectSmoke(window);
        await captureLayout('tasks', '.task-layout');
      }
      evidence.layouts = layouts;
      await fs.writeFile('test-results/smoke.json', JSON.stringify(evidence, null, 2));
      console.log('Electron smoke PASS: Vue 页面已加载、受限桥接可用、页面无 Node 权限');
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  }
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
