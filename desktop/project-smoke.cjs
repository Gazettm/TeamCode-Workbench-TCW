const fs = require('node:fs/promises');

async function exerciseProjects() {
  const wait = async (check, step) => {
    for (let i = 0; i < 160; i++) {
      if (check()) return;
      const error = document.querySelector('.collab .error');
      if (error) throw new Error(step + ': ' + error.textContent);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const detail = document.querySelector('.task-detail');
    const status = detail?.querySelector('.badge')?.textContent;
    const buttons = [...(detail?.querySelectorAll('button') || [])].map(button => button.textContent.trim() + (button.disabled ? ' [disabled]' : ''));
    throw new Error('Desktop smoke timed out: ' + step + ' ' + JSON.stringify({ status, buttons }));
  };
  const set = (selector, value) => {
    const input = document.querySelector(selector);
    if (!input) throw new Error('Missing field ' + selector);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const press = (selector, text) => {
    const button = [...document.querySelectorAll(selector)].find(item => item.textContent.trim() === text);
    if (!button) throw new Error('Missing button ' + text);
    if (button.disabled) throw new Error('Disabled button ' + text);
    button.click();
  };
  const openView = async id => {
    const button = () => document.querySelector('#project-' + id + '-view');
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    await wait(()=>button() && !button().disabled, 'project view available ' + id);
    button().click();
    await wait(()=>button()?.getAttribute('aria-pressed')==='true', 'project view active ' + id);
  };
  const suffix = crypto.randomUUID().slice(0, 12);
  const pass = crypto.randomUUID();
  const offline = (await window.tcw.bootstrap()).data;
  const projectName = '课程协作演示 ' + suffix.slice(0, 4);
  const login = async (username, display) => {
    set('#account-name', username); set('#account-password', pass);
    await new Promise(resolve => setTimeout(resolve, 20));
    press('.login-panel button','登录');
    await wait(() => document.querySelector('.identity-line')?.textContent.includes(display)
      && !document.querySelector('.identity-line button')?.disabled, 'login');
  };
  const registerLogin = async (username, display) => {
    press('.login-panel button', '注册账号');
    await wait(() => document.querySelector('#display-name'), 'register form');
    set('#account-name', username); set('#display-name', display); set('#account-password', pass);
    await new Promise(resolve => setTimeout(resolve, 20));
    press('.login-panel button','创建账号');
    await wait(() => document.querySelector('.collab .success')?.textContent.includes('账号已创建'), 'register');
    await login(username, display);
  };
  press('.sidebar .nav','◷ 协作项目');
  await wait(() => document.querySelector('.login-panel'), 'login form');
  await registerLogin('desktop_a_' + suffix, '联调组长');
  const signedIn = (await window.tcw.bootstrap()).data;
  if (signedIn.scope === offline.scope || signedIn.workspaces.length || Object.keys(signedIn.notes).length) {
    throw new Error('Offline notes leaked into signed-in scope');
  }
  const forbidden = await window.tcw.list(offline.scope, offline.workspaces[0].id, '');
  if (forbidden.ok || forbidden.code !== 'SCOPE_CHANGED') throw new Error('Old workspace scope was accepted');
  document.querySelector('#show-create-project').click();
  await wait(()=>document.querySelector('#new-project'),'project form');
  set('#new-project', projectName);
  await new Promise(resolve => setTimeout(resolve, 20));
  press('.project-list button','创建项目');
  await wait(() => document.querySelector('.project-title h2')?.textContent === projectName
      && !document.querySelector('.identity-line button')?.disabled, 'create project');
  document.querySelector('#show-create-project').click();
  await wait(()=>document.querySelector('#new-project'),'second project form');
  set('#new-project', projectName + ' 二');
  await new Promise(resolve => setTimeout(resolve, 20));
  press('.project-list button','创建项目');
  await wait(() => document.querySelector('.project-title h2')?.textContent === projectName + ' 二'
      && !document.querySelector('.identity-line button')?.disabled, 'create second project');
  [...document.querySelectorAll('.project-choice')].find(button => button.firstElementChild.textContent === projectName).click();
  await wait(() => document.querySelector('.project-title h2')?.textContent === projectName
      && !document.querySelector('.identity-line button')?.disabled, 'switch to first project');
  await openView('members');
  await wait(()=>document.querySelector('#invite-hours'),'member view');
  press('.project-detail button','生成邀请码');
  await wait(() => document.querySelector('#issued-code')?.value
      && !document.querySelector('.identity-line button')?.disabled, 'issue invitation');
  const code = document.querySelector('#issued-code').value;
  press('.identity-line button','退出登录');
  await wait(() => document.querySelector('.login-panel'), 'logout owner');
  const after = (await window.tcw.bootstrap()).data;
  if (after.scope !== offline.scope || !Object.values(after.notes)[0]?.['README.md']) throw new Error('Offline note did not return');
  await registerLogin('desktop_b_' + suffix, '联调组员');
  document.querySelector('#show-join-project').click();
  await wait(()=>document.querySelector('#join-code'),'invite form');
  set('#join-code', code);
  await new Promise(resolve => setTimeout(resolve, 20));
  press('.project-list button','加入项目');
  await wait(()=>document.querySelector('.project-title h2')?.textContent===projectName
    && !document.querySelector('#project-members-view').disabled,'joined project');
  await openView('members');
  await wait(() => document.querySelector('.project-detail .member-list')?.textContent.includes('联调组长')
      && document.querySelector('.project-detail .member-list')?.textContent.includes('联调组员')
      && !document.querySelector('.identity-line button')?.disabled, 'join and list roster');
  if (document.querySelector('#invite-hours')) throw new Error('Member can see owner invitation controls');
  const reviewer = (await window.tcw.bootstrap()).data.user;
  press('.identity-line button','退出登录');
  await wait(() => document.querySelector('.login-panel'), 'logout member');
  await login('desktop_a_' + suffix, '联调组长');
  const projectChoice = () => [...document.querySelectorAll('.project-choice')].find(button => button.firstElementChild.textContent === projectName);
  await wait(() => projectChoice() && !projectChoice().disabled, 'project list');
  if (!projectChoice().classList.contains('current-project')) projectChoice().click();
  window.confirm=()=>true;
  await wait(() => document.querySelector('.project-title h2')?.textContent===projectName && !document.querySelector('.identity-line button')?.disabled, 'owner project');
  press('.sidebar .nav','▦ 本地工作区');
  await wait(() => document.querySelector('.workspace-header'), 'signed-in local workspace');
  press('.workspace-header button','＋ 导入 Git 仓库');
  await wait(() => document.querySelector('.workspace-bar select')?.options.length===2 && !document.querySelector('.workspace-bar select').disabled, 'import into signed-in workspace');
  press('.sidebar .nav','◷ 协作项目');
  await wait(() => projectChoice() && !projectChoice().disabled, 'open project again');
  if (!projectChoice().classList.contains('current-project')) projectChoice().click();
  await wait(() => document.querySelector('.project-title h2')?.textContent===projectName
    && !document.querySelector('#project-members-view').disabled, 'member view ready');
  await openView('members');
  await wait(() => document.querySelector('#project-repo')?.options.length===2 && !document.querySelector('#project-repo').disabled, 'project repository selector');
  const projectRepo=document.querySelector('#project-repo');
  projectRepo.value=projectRepo.options[1].value;
  projectRepo.dispatchEvent(new Event('change',{bubbles:true}));
  await wait(() => projectRepo.value && !projectRepo.disabled, 'bind project repository');
  await openView('tasks');
  await wait(()=>document.querySelector('#show-create-task') && !document.querySelector('#show-create-task').disabled,'task view');
  document.querySelector('#show-create-task').click();
  const taskReady = status => document.querySelector('.task-detail .badge')?.textContent===status && !document.querySelector('.task-area .task-heading button').disabled;
  const taskButton = label => [...document.querySelectorAll('.task-detail button')].find(button => button.textContent.trim() === label);
  await wait(()=>document.querySelector('.project-title h2')?.textContent===projectName
    && document.querySelector('.task-create button') && !document.querySelector('.task-create button').disabled,'task board and roster');
  set('#task-title','0.4.2 桌面验收闭环');
  const selectAssignee=document.querySelector('.task-fields select');
  if (![...selectAssignee.options].some(option => option.value===signedIn.user.id)) throw new Error('Owner missing from the assignee list');
  selectAssignee.value=signedIn.user.id;selectAssignee.dispatchEvent(new Event('change',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,30));
  press('.task-create button','发布任务');
  await wait(()=>taskReady('已指派'),'publish task');
  await wait(()=>taskButton('从当前提交创建任务分支') && !taskButton('从当前提交创建任务分支').disabled,'task Git controls');
  press('.task-detail button','从当前提交创建任务分支');
  await wait(()=>taskReady('已指派') && taskButton('开始工作') && !taskButton('开始工作').disabled
    && taskButton('切换到任务分支')?.disabled && document.querySelector('.task-git .hint')?.textContent.includes('当前 task/'),'create and associate task branch');
  press('.task-detail button','开始工作');
  await wait(()=>taskReady('进行中'),'start task');
  set('#task-operation-text','已完成界面和接口验证');
  await new Promise(resolve=>setTimeout(resolve,30));
  press('.task-detail button','提交验收');
  await wait(()=>taskReady('待验收') && taskButton('委派复核'),'submit task');
  const reviewerSelect=document.querySelector('.task-detail select');
  const options=[...reviewerSelect.options].map(option=>option.value).filter(Boolean);
  if (options.length!==1 || options[0]!==reviewer.id) throw new Error('Invalid reviewer choices');
  reviewerSelect.value=reviewer.id;reviewerSelect.dispatchEvent(new Event('change',{bubbles:true}));
  await wait(()=>!taskButton('委派复核').disabled,'enable delegation');
  press('.task-detail button','委派复核');
  await wait(()=>taskReady('待验收') && taskButton('撤回复核委派'),'delegate review');
  set('#task-operation-text','尝试提前退回');
  await new Promise(resolve=>setTimeout(resolve,30));
  if (taskButton('委派复核') || !taskButton('验收通过').disabled || !taskButton('退回').disabled) throw new Error('Waiting for opinion did not lock the decision');
  press('.task-detail button','撤回复核委派');
  await wait(()=>taskReady('待验收') && taskButton('验收通过') && !taskButton('验收通过').disabled,'revoke and unlock');
  press('.task-detail button','验收通过');
  await wait(()=>taskReady('已完成'),'accept task');
  const filter=document.querySelector('#task-status-filter');
  filter.value='OPEN';
  filter.dispatchEvent(new Event('change',{bubbles:true}));
  await wait(()=>!document.querySelector('.task-card'),'task filter');
  filter.value='DONE';
  filter.dispatchEvent(new Event('change',{bubbles:true}));
  await wait(()=>document.querySelector('.task-card')?.textContent.includes('0.4.2 桌面验收闭环'),'show completed task');
  await openView('activity');
  await wait(()=>document.querySelector('.activity-list')?.textContent.includes('验收通过'),'activity view');
  await openView('tasks');
  await wait(()=>taskReady('已完成'),'return to task details');
  return { accountScope: true, ownerCreated: true, projectSwitch: true, memberJoined: true, taskLifecycle:true, reviewDelegation:true, taskBranch:true, taskFilter:true, projectTabs:true };
}

async function runProjectSmoke(window) {
  const result = await window.webContents.executeJavaScript('(' + exerciseProjects.toString() + ')()');
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.writeFile('test-results/collaboration.png', (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('.task-area').scrollIntoView({block:'start'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await fs.writeFile('test-results/tasks.png', (await window.webContents.capturePage()).toPNG());
  return result;
}

module.exports = { runProjectSmoke };
