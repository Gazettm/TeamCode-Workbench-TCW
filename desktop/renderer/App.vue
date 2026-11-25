<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount, provide } from 'vue';
import Projects from './Projects.vue';
import GitPanel from './GitPanel.vue';
import GitSettings from './GitSettings.vue';
import OperationDialog from './OperationDialog.vue';
const page = ref('workspace');
const state = ref({ workspaces: [], notes: {}, gitBindings: {}, settings: { serverUrl: 'http://localhost:8080' }, scope: 'offline', user: null });
const current = ref(null), entries = ref([]), relative = ref(''), selected = ref(null), note = ref(''), savedNote = ref('');
const repo = ref(null), busy = ref(false), error = ref(''), message = ref(''), ready = ref(false), serverUrl = ref(''), truncated = ref(false);
const sharedBusy = ref(false);
const workspaceView = ref('files'), gitVisited = ref(false), showClone = ref(false);
const gitBusy = ref(false), authorId = ref(''), cloneAddress = ref(''), cloning = ref(false), cloneProgress = ref(null), cloneAuthError = ref(false);
const phases = { 'Enumerating objects': '列出对象', 'Counting objects': '统计对象', 'Compressing objects': '压缩对象',
  'Receiving objects': '接收对象', 'Resolving deltas': '处理差异', 'Updating files': '检出文件' };
const authorWorkspace = computed(() => state.value.workspaces.find(item => item.id === (authorId.value || current.value)));
const active = computed(() => state.value.workspaces.find(item => item.id === current.value));
const changed = computed(() => note.value !== savedNote.value);
const confirmation = ref(null);
let resolveConfirmation;
provide('confirmAction', (title, detail, operation = '') => {
  if (confirmation.value) return Promise.resolve(false);
  return new Promise(resolve => {
    resolveConfirmation = resolve;
    confirmation.value = { title, detail, operation };
  });
});
function decide(accepted, keepBackup) {
  const request = confirmation.value;
  confirmation.value = null;
  if (request?.id) return window.tcw.decideOperation(request.id, accepted, keepBackup);
  resolveConfirmation?.(accepted);
  resolveConfirmation = null;
}
const api = async (method, ...args) => {
  if (!window.tcw) throw new Error('请通过 Electron 客户端启动，此页面不支持独立浏览器操作');
  const response = await window.tcw[method](...args);
  if (!response.ok) throw Object.assign(new Error(response.error), { code: response.code });
  return response.data;
};
async function run(action) {
  if (busy.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try { await action(); }
  catch (e) {
    error.value = e.message;
    if (e.code === 'SCOPE_CHANGED') {
      try { await reload(); } catch (stateError) { error.value += ' ' + stateError.message; }
    }
  } finally { busy.value = false; }
}
function allowLeave() { return !changed.value || window.confirm('备注尚未保存，确定放弃这次修改吗？'); }
function resetWorkspace() {
  current.value = null; entries.value = []; relative.value = ''; selected.value = null;
  note.value = ''; savedNote.value = ''; repo.value = null; truncated.value = false;
  workspaceView.value = 'files'; gitVisited.value = false; showClone.value = false;
}
async function reload() {
  const next = await api('bootstrap');
  if (next.scope !== state.value.scope) { resetWorkspace(); authorId.value = ''; }
  state.value = next; serverUrl.value = next.settings.serverUrl;
}
function switchPage(next) {
  if (busy.value || sharedBusy.value || gitBusy.value) return;
  page.value = next; error.value = ''; message.value = '';
}
function showGit() {
  gitVisited.value = true;
  workspaceView.value = 'git';
}
async function openAuthorSettings() {
  if (active.value) authorId.value = active.value.id;
  switchPage('settings');
  await nextTick();
  document.getElementById('git-author-settings')?.scrollIntoView({ block: 'start' });
}
function saveAddress() {
  if (state.value.user && serverUrl.value !== state.value.settings.serverUrl && !allowLeave()) return;
  return run(async () => {
    const result = await api('saveSettings', serverUrl.value);
    await reload();
    message.value = result.logout
      ? result.logout.remote ? '设置已保存，原服务账号已退出。' : '设置已保存并在本机退出；旧服务不可达，旧会话将过期。'
      : '设置已保存。';
  });
}
const checkAddress = () => run(async () => {
  if (serverUrl.value !== state.value.settings.serverUrl) throw new Error('请先保存服务地址。');
  const status = await api('collaborate', 'health');
  message.value = '协作服务连接成功（' + status.version + '）。';
});
async function loadDirectory(target = '') {
  const result = await api('list', state.value.scope, current.value, target);
  relative.value = target; entries.value = result.entries; truncated.value = result.truncated;
}
async function switchWorkspace(id) {
  if (!allowLeave()) return;
  await run(async () => {
    current.value = id; selected.value = null; note.value = ''; savedNote.value = ''; entries.value = []; relative.value = ''; repo.value = null;
    repo.value = await api('status', state.value.scope, id); await loadDirectory();
  });
}
async function importWorkspace() {
  if (!allowLeave()) return;
  let imported;
  await run(async () => {
    imported = await api('importWorkspace', state.value.scope);
    if (imported) await reload();
  });
  if (imported) await switchWorkspace(imported.id);
}
async function cloneWorkspace() {
  if (!allowLeave()) return;
  let imported;
  await run(async () => {
    cloning.value = true; cloneProgress.value = null; cloneAuthError.value = false;
    try {
      imported = await api('cloneWorkspace', state.value.scope, cloneAddress.value);
      if (imported) { cloneAddress.value = ''; showClone.value = false; await reload(); }
    } catch (failure) {
      cloneAuthError.value = failure.code === 'GIT_AUTH';
      throw failure;
    } finally { cloning.value = false; cloneProgress.value = null; }
  });
  if (imported) await switchWorkspace(imported.id);
}
async function updateFromGit() {
  await run(async () => {
    repo.value = await api('status', state.value.scope, current.value);
    await loadDirectory(relative.value).catch(() => loadDirectory());
  });
}
async function bindGit(projectId, workspaceId, taskId = null, branch = null) {
  state.value.gitBindings = await api('bindGit', state.value.scope, projectId, workspaceId, taskId, branch);
}
function select(entry) {
  if (!allowLeave()) return;
  selected.value = entry;
  note.value = state.value.notes[current.value]?.[entry.path] || '';
  savedNote.value = note.value;
}
async function openDirectory(entry) { if (allowLeave()) await run(() => loadDirectory(entry.path)); }
async function up() { if (allowLeave()) await run(() => loadDirectory(relative.value.split('/').slice(0, -1).join('/'))); }
async function saveNote() {
  await run(async () => {
    const snapshot = note.value;
    await api('saveNote', state.value.scope, current.value, selected.value.path, snapshot);
    const previousScope = state.value.scope;
    await reload();
    if (previousScope === state.value.scope) savedNote.value = snapshot;
    message.value = changed.value ? '上一次备注已保存；当前输入还有新修改' : '备注已保存到本机';
  });
}
async function refresh() {
  await run(async () => { repo.value = await api('status', state.value.scope, current.value); await loadDirectory(relative.value); message.value = '仓库状态已刷新'; });
}
let unsubscribe, unsubscribeConfirmation;
onMounted(async () => {
  unsubscribe = window.tcw?.onCloneProgress(progress => { cloneProgress.value = progress; });
  unsubscribeConfirmation = window.tcw?.onOperationConfirmation(request => { confirmation.value = request; });
  await run(reload);
  ready.value = true;
});
onBeforeUnmount(() => { unsubscribe?.(); unsubscribeConfirmation?.(); });
window.addEventListener('beforeunload', event => { if (changed.value) { event.preventDefault(); event.returnValue = ''; } });
</script>

<template>
  <OperationDialog :request="confirmation" @decision="decide" />
  <div class="shell" :data-ready="ready">
    <aside class="sidebar">
      <div class="brand"><span class="logo" aria-hidden="true">T</span><span>协作工作台</span></div>
      <nav class="sidebar-nav" aria-label="主导航">
        <button title="本地工作区" :class="['nav', { active: page === 'workspace' }]" :aria-current="page === 'workspace' ? 'page' : undefined" @click="switchPage('workspace')">▦ <span>本地工作区</span></button>
        <button title="协作项目" :class="['nav', { active: page === 'projects' }]" :aria-current="page === 'projects' ? 'page' : undefined" @click="switchPage('projects')">◷ <span>协作项目</span></button>
      </nav>
      <div class="sidebar-bottom">
        <button title="设置" :class="['nav', { active: page === 'settings' }]" :aria-current="page === 'settings' ? 'page' : undefined" @click="switchPage('settings')">⚙ <span>设置</span></button>
        <div class="version">TCW <span>v{{ state.version || '0.4.7' }}</span></div>
      </div>
    </aside>
    <main>
      <header class="topbar">
        <h1>{{ page === 'workspace' ? '本地工作区' : page === 'settings' ? '设置' : '协作项目' }}</h1>
        <span class="account-status" role="status">{{ busy || sharedBusy || gitBusy ? '正在处理…' : state.user?.displayName || '离线模式' }}</span>
      </header>
      <div class="content">
        <div v-if="error" class="notice error" role="alert">{{ error }}</div>
        <div v-if="message" class="notice success" role="status">{{ message }}</div>

        <template v-if="page === 'workspace'">
          <section class="panel workspace-header" aria-label="当前仓库">
            <div class="workspace-bar">
              <div class="repo-picker">
                <label for="workspace-picker">工作区</label>
                <select v-if="state.workspaces.length" id="workspace-picker" :value="current || ''" :disabled="busy || gitBusy" @change="switchWorkspace($event.target.value)">
                  <option value="" disabled>选择一个工作区</option>
                  <option v-for="item in state.workspaces" :key="item.id" :value="item.id" :title="item.root">{{ item.name }} — {{ item.root }}</option>
                </select>
                <strong v-else>未导入仓库</strong>
              </div>
              <div class="button-line">
                <button type="button" :aria-expanded="showClone" :disabled="busy || gitBusy" @click="showClone = !showClone">克隆 GitHub 仓库</button>
                <button class="primary" :disabled="busy || gitBusy" @click="importWorkspace">＋ 导入 Git 仓库</button>
              </div>
            </div>
            <form v-if="showClone || cloning" class="clone-form" @submit.prevent="cloneWorkspace">
              <label for="clone-url">GitHub 仓库地址</label>
              <div class="button-line">
                <input id="clone-url" v-model.trim="cloneAddress" placeholder="https://github.com/owner/repo" :disabled="busy || gitBusy" required>
                <button :disabled="busy || gitBusy || !cloneAddress">选择目录并克隆</button>
                <button v-if="cloneAuthError && !cloning" type="button" @click="openAuthorSettings">打开 Git 与 GitHub 设置</button>
                <button v-if="cloning" type="button" @click="api('cancelClone')">取消克隆</button>
              </div>
              <p v-if="cloning" role="status">{{ phases[cloneProgress?.phase] || cloneProgress?.phase || '等待选择目录' }} {{ Number.isFinite(cloneProgress?.percent) ? cloneProgress.percent + '%' : '' }}</p>
              <progress v-if="cloning && cloneProgress" max="100" :value="cloneProgress.percent ?? null"></progress>
            </form>
            <div v-if="active" class="repository-meta">
              <span class="root-path" :title="active.root">{{ active.root }}</span>
              <span class="pill branch-pill" :title="repo?.branch">⑂ {{ repo?.branch || '读取分支…' }}</span>
              <span :class="['pill', repo?.dirty ? 'pill-pending' : 'pill-clean']">{{ repo ? repo.dirty ? '有未提交改动' : '工作区干净' : '读取状态…' }}</span>
            </div>
          </section>
          <div v-if="!active" class="panel empty">
            <h2>{{ state.workspaces.length ? '选择要打开的工作区' : '添加你的第一个仓库' }}</h2>
            <p>{{ state.workspaces.length ? '选择上方的仓库，查看文件、备注和 Git 改动。' : '从本机导入已有仓库，或输入 GitHub 地址克隆。' }}</p>
          </div>
          <template v-else>
            <div class="section-bar">
              <nav class="view-tabs" aria-label="工作区视图">
                <button id="files-view" :aria-pressed="workspaceView === 'files'" :disabled="busy || gitBusy" @click="workspaceView = 'files'">文件与备注</button>
                <button id="git-view" :aria-pressed="workspaceView === 'git'" :disabled="busy || gitBusy" @click="showGit">Git 操作</button>
              </nav>
              <button v-if="workspaceView === 'files'" :disabled="busy || gitBusy" @click="refresh">刷新文件</button>
            </div>
            <div v-show="workspaceView === 'files'" class="explorer panel">
              <section class="file-pane">
                <div class="pane-title"><h2>文件与目录</h2><span>{{ entries.length }} 项</span></div>
                <div class="path-bar"><button type="button" aria-label="返回上一级" :disabled="!relative || busy" @click="up">↑</button><span>{{ relative || '仓库根目录' }}</span></div>
                <div class="file-list">
                  <div v-for="entry in entries" :key="entry.path" class="file-entry">
                    <button :class="['file-row', { selected: selected?.path === entry.path }]" :disabled="busy" @click="select(entry)" @dblclick="entry.directory && openDirectory(entry)">
                      <span class="file-icon" aria-hidden="true">{{ entry.directory ? '▰' : '▤' }}</span>
                      <span class="file-name">{{ entry.name }}<small v-if="state.notes[current]?.[entry.path]">{{ state.notes[current][entry.path] }}</small></span>
                    </button>
                    <button v-if="entry.directory" class="open-folder" type="button" :disabled="busy" :aria-label="'打开 ' + entry.name" @click="openDirectory(entry)">›</button>
                  </div>
                  <p v-if="!entries.length" class="muted">此目录没有可显示的文件。</p>
                  <p v-if="truncated" class="muted">仅展示前 1000 项。</p>
                </div>
              </section>
              <section class="note-pane">
                <div class="pane-title"><h2>个人备注</h2><span class="local-tag">仅本机</span></div>
                <div v-if="selected" class="note-editor">
                  <div class="selected-path">{{ selected.path }}</div>
                  <textarea aria-label="个人备注" v-model="note" maxlength="4000" placeholder="记录文件用途或修改前要确认的事项"></textarea>
                  <div class="note-footer"><small>{{ note.length }}/4000 {{ changed ? '· 尚未保存' : '' }}</small><button class="primary" :disabled="busy || !changed" @click="saveNote">保存备注</button></div>
                </div>
                <div v-else class="note-empty"><strong>选择一个文件或目录</strong><p>备注会保存在此工作区。</p></div>
              </section>
            </div>
            <GitPanel v-if="gitVisited" v-show="workspaceView === 'git'" :key="active.id" :workspace="active" :scope="state.scope" :api="api" @pending="gitBusy = $event" @changed="updateFromGit" @configure-author="openAuthorSettings" />
          </template>
        </template>

        <template v-if="page === 'settings'">
          <div class="settings-layout">
            <section class="panel settings service-settings">
              <h2>协作服务</h2>
              <p>本机试用地址为 http://localhost:8080。更换地址会退出当前协作账号。</p>
              <form class="collab-form" @submit.prevent="saveAddress">
                <label for="server">服务地址</label>
                <input id="server" v-model="serverUrl" placeholder="http://localhost:8080">
                <div class="button-line"><button class="primary" :disabled="busy">保存设置</button><button type="button" :disabled="busy" @click="checkAddress">测试连接</button></div>
              </form>
            </section>
            <section id="git-author-settings" class="panel settings author-settings">
              <h2>Git 与 GitHub</h2>
              <div class="collab-form">
                <label for="author-workspace">工作区</label>
                <select id="author-workspace" :value="authorWorkspace?.id || ''" :disabled="gitBusy" @change="authorId = $event.target.value">
                  <option value="" disabled>选择已导入的工作区</option>
                  <option v-for="item in state.workspaces" :key="item.id" :value="item.id" :title="item.root">{{ item.name }}</option>
                </select>
              </div>
              <GitSettings :key="authorWorkspace?.id || state.scope" :workspace="authorWorkspace" :scope="state.scope" :api="api" @pending="gitBusy = $event" />
            </section>
            <section class="panel settings local-settings">
              <h2>本地数据</h2>
              <p>备注、工作区和分支关联按当前协作账号保存在本机。退出登录可返回离线工作区。</p>
              <code>{{ state.dataPath }}</code>
            </section>
          </div>
        </template>
        <Projects v-if="page === 'projects'" :user="state.user" :server-url="state.settings.serverUrl" :api="api" :sync-session="reload" :allow-switch="allowLeave" :scope="state.scope" :workspaces="state.workspaces" :git-bindings="state.gitBindings" :bind-git="bindGit" @pending="sharedBusy = $event" />
      </div>
    </main>
  </div>
</template>
