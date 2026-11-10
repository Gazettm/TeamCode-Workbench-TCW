const fs = require('node:fs/promises');

async function exerciseProjects() {
  const wait = async (check, step) => {
    for (let i = 0; i < 160; i++) {
      if (check()) return;
      const error = document.querySelector('.collab .error');
      if (error) throw new Error(step + ': ' + error.textContent);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Desktop smoke timed out: ' + step);
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
    button.click();
  };
  const suffix = crypto.randomUUID().slice(0, 12);
  const pass = crypto.randomUUID();
  const offline = (await window.tcw.bootstrap()).data;
  const projectName = '课程协作演示 ' + suffix.slice(0, 4);
  const registerLogin = async (username, display) => {
    press('.login-panel button', '注册账号');
    await wait(() => document.querySelector('#display-name'), 'register form');
    set('#account-name', username); set('#display-name', display); set('#account-password', pass);
    await new Promise(resolve => setTimeout(resolve, 20));
    press('.login-panel button','创建账号');
    await wait(() => document.querySelector('.collab .success')?.textContent.includes('账号已创建'), 'register');
    set('#account-password', pass);
    await new Promise(resolve => setTimeout(resolve, 20));
    press('.login-panel button','登录');
    await wait(() => document.querySelector('.identity-line')?.textContent.includes(display)
      && !document.querySelector('.identity-line button')?.disabled, 'login');
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
  set('#new-project', projectName);
  await new Promise(resolve => setTimeout(resolve, 20));
  press('.project-list button','创建项目');
  await wait(() => document.querySelector('.project-title h2')?.textContent === projectName
      && document.querySelector('.project-detail .member-list')?.textContent.includes('联调组长')
      && !document.querySelector('.identity-line button')?.disabled, 'create project');
  set('#new-project', projectName + ' 二');
  await new Promise(resolve => setTimeout(resolve, 20));
  press('.project-list button','创建项目');
  await wait(() => document.querySelector('.project-title h2')?.textContent === projectName + ' 二'
      && !document.querySelector('.identity-line button')?.disabled, 'create second project');
  [...document.querySelectorAll('.project-choice')].find(button => button.firstElementChild.textContent === projectName).click();
  await wait(() => document.querySelector('.project-title h2')?.textContent === projectName
      && !document.querySelector('.identity-line button')?.disabled, 'switch to first project');
  press('.project-detail button','生成邀请码');
  await wait(() => document.querySelector('#issued-code')?.value
      && !document.querySelector('.identity-line button')?.disabled, 'issue invitation');
  const code = document.querySelector('#issued-code').value;
  press('.page-heading button','退出登录');
  await wait(() => document.querySelector('.login-panel'), 'logout owner');
  const after = (await window.tcw.bootstrap()).data;
  if (after.scope !== offline.scope || !Object.values(after.notes)[0]?.['README.md']) throw new Error('Offline note did not return');
  await registerLogin('desktop_b_' + suffix, '联调组员');
  set('#join-code', code);
  await new Promise(resolve => setTimeout(resolve, 20));
  press('.project-list button','加入项目');
  await wait(() => document.querySelector('.project-detail .member-list')?.textContent.includes('联调组长')
      && document.querySelector('.project-detail .member-list')?.textContent.includes('联调组员')
      && !document.querySelector('.identity-line button')?.disabled, 'join and list roster');
  if (document.querySelector('#invite-hours')) throw new Error('Member can see owner invitation controls');
  return { accountScope: true, ownerCreated: true, projectSwitch: true, memberJoined: true };
}

async function runProjectSmoke(window) {
  const result = await window.webContents.executeJavaScript('(' + exerciseProjects.toString() + ')()');
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.writeFile('test-results/collaboration.png', (await window.webContents.capturePage()).toPNG());
  return result;
}

module.exports = { runProjectSmoke };
