const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Store, Workbench } = require('./core.cjs');
const { CollaborationClient } = require('./collaboration.cjs');
const smoke = process.argv.includes('--smoke');
if (!smoke && !app.requestSingleInstanceLock()) app.exit(0);
if (smoke) app.setPath('userData', path.join(app.getPath('temp'), `tcw-smoke-${process.pid}`));
let window;
app.whenReady().then(async () => {
  const dataPath = app.getPath('userData');
  const store = new Store(dataPath);
  const collaboration = new CollaborationClient(store);
  const stores = new Map([['offline', store]]);
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
    const { promisify } = require('node:util');
    const execFile = promisify(require('node:child_process').execFile);
    const fixture = path.join(app.getPath('userData'), '演示仓库');
    await fs.mkdir(fixture, { recursive: true });
    await execFile('git', ['init', '-b', 'main', fixture], { windowsHide: true });
    await fs.writeFile(path.join(fixture, 'README.md'), '# TCW smoke fixture');
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
    const { workspaces, notes } = await local.read();
    const { settings } = await store.read();
    if (identity.scope !== collaboration.identity().scope) throw new Error('登录状态已变化，请重试。');
    return { workspaces, notes, settings, ...identity, version: app.getVersion(), dataPath: path.dirname(local.file) };
  });
  handle('workspace:import', async scope => {
    workbench(scope);
    const result = await dialog.showOpenDialog(window, { title: '选择已有 Git 仓库', properties: ['openDirectory'] });
    return result.canceled ? null : workbench(scope).importDirectory(result.filePaths[0]);
  });
  handle('workspace:list', (scope, id, relative) => workbench(scope).list(id, relative));
  handle('workspace:status', (scope, id) => workbench(scope).status(id));
  handle('note:save', (scope, id, relative, text) => workbench(scope).saveNote(id, relative, text));
  handle('settings:save', serverUrl => collaboration.saveAddress(serverUrl));
  handle('collaboration', (operation, input) => collaboration.run(operation, input));
  window = new BrowserWindow({ width: 1280, height: 840, minWidth: 960, minHeight: 640, title: '协作工作台', backgroundColor: '#f5f7fb', show: !smoke, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
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
      evidence.text = await window.webContents.executeJavaScript('document.body.innerText');
      await window.webContents.executeJavaScript(`(async()=>{
        document.querySelectorAll('.sidebar-bottom .nav')[0].click();
        await new Promise(r=>setTimeout(r,100));
        const input=document.querySelector('#server');input.value=${JSON.stringify(testService)};input.dispatchEvent(new Event('input',{bubbles:true}));
        await new Promise(r=>setTimeout(r,50));document.querySelector('.settings .primary').click();
        for(let i=0;i<100;i++){if(document.querySelector('.success')?.textContent.includes('设置已保存'))return;await new Promise(r=>setTimeout(r,50))}throw new Error('设置保存失败');
      })()`);
      if ((await store.read()).settings.serverUrl !== testService) throw new Error('设置未持久化');
      evidence.checks = ['Vue 加载', 'preload 桥接', 'Node 隔离', '仓库选择与文件展示', '页面备注保存', '页面设置保存'];
      evidence.fontSizes = sizes;
      if (process.env.TCW_SMOKE_SERVER_URL) {
        evidence.collaboration = await require('./project-smoke.cjs').runProjectSmoke(window);
      }
      await fs.writeFile('test-results/smoke.json', JSON.stringify(evidence, null, 2));
      console.log('Electron smoke PASS: Vue 页面已加载、受限桥接可用、页面无 Node 权限');
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  }
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
