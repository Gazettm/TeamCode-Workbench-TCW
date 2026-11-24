<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import Projects from './Projects.vue';
import GitPanel from './GitPanel.vue';
const page = ref('workspace');
const state = ref({ workspaces: [], notes: {}, gitBindings: {}, settings: { serverUrl: 'http://localhost:8080' }, scope: 'offline', user: null });
const current = ref(null), entries = ref([]), relative = ref(''), selected = ref(null), note = ref(''), savedNote = ref('');
const repo = ref(null), busy = ref(false), error = ref(''), message = ref(''), ready = ref(false), serverUrl = ref(''), truncated = ref(false);
const sharedBusy = ref(false);
const gitBusy = ref(false), authorId = ref(''), cloneAddress = ref(''), cloning = ref(false), cloneProgress = ref(null);
const phases = { 'Enumerating objects': '列出对象', 'Counting objects': '统计对象', 'Compressing objects': '压缩对象',
  'Receiving objects': '接收对象', 'Resolving deltas': '处理差异', 'Updating files': '检出文件' };
const authorWorkspace = computed(() => state.value.workspaces.find(item => item.id === (authorId.value || current.value)));
const active = computed(() => state.value.workspaces.find(item => item.id === current.value));
const changed = computed(() => note.value !== savedNote.value);
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
async function openAuthorSettings() {
  if (!active.value) return;
  authorId.value = active.value.id;
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
    cloning.value = true; cloneProgress.value = null;
    try {
      imported = await api('cloneWorkspace', state.value.scope, cloneAddress.value);
      if (imported) { cloneAddress.value = ''; await reload(); }
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
let unsubscribe;
onMounted(async () => {
  unsubscribe = window.tcw?.onCloneProgress(progress => { cloneProgress.value = progress; });
  await run(reload);
  ready.value = true;
});
onBeforeUnmount(() => unsubscribe?.());
window.addEventListener('beforeunload', event => { if (changed.value) { event.preventDefault(); event.returnValue = ''; } });
</script>

<template>
  <div class="shell" :data-ready="ready">
    <aside class="sidebar">
      <div class="brand"><span class="logo">T</span><div>协作工作台<small>TEAMCODE WORKBENCH</small></div></div>
      <div class="nav-label">工作空间</div>
      <button :class="['nav', { active: page === 'workspace' }]" @click="switchPage('workspace')">▦ <span>本地工作区</span></button>
      <button :class="['nav', { active: page === 'projects' }]" @click="switchPage('projects')">◷ <span>协作项目</span></button>
      <div class="sidebar-bottom"><button :class="['nav', { active: page === 'settings' }]" @click="switchPage('settings')">⚙ <span>设置</span></button><div class="version">TCW <span>v{{ state.version || '0.4.1' }}</span></div></div>
    </aside>
    <main>
      <header><div class="breadcrumb">协作工作台 <span>/</span> {{ page === 'workspace' ? '本地工作区' : page === 'settings' ? '设置' : '协作项目' }}</div><span class="badge">{{ state.user ? state.user.displayName : '离线工作区' }} · 0.4</span></header>
      <div class="content">
        <div v-if="error" class="notice error" role="alert">{{ error }}</div><div v-if="message" class="notice success" role="status">{{ message }}</div>
        <template v-if="page === 'workspace'">
          <div class="page-heading"><div><h1>本地工作区</h1></div><button class="primary" :disabled="busy || gitBusy" @click="importWorkspace">＋ 导入 Git 仓库</button></div>
          <form class="panel git-panel collab-form" @submit.prevent="cloneWorkspace">
            <label for="clone-url">GitHub 仓库地址</label>
            <input id="clone-url" v-model.trim="cloneAddress" placeholder="https://github.com/owner/repo" :disabled="busy || gitBusy" required>
            <div class="button-line"><button :disabled="busy || gitBusy || !cloneAddress">选择目录并克隆</button><button v-if="cloning" type="button" @click="api('cancelClone')">取消克隆</button></div>
            <p v-if="cloning" role="status">{{ phases[cloneProgress?.phase] || cloneProgress?.phase || '等待选择目录' }} {{ Number.isFinite(cloneProgress?.percent) ? cloneProgress.percent + '%' : '' }}</p>
            <progress v-if="cloning && cloneProgress" max="100" :value="cloneProgress.percent ?? null"></progress>
          </form>
          <div class="stats"><div><small>已导入工作区</small><strong>{{ state.workspaces.length.toString().padStart(2, '0') }}</strong></div><div><small>当前分支</small><strong class="branch">{{ repo?.branch || '—' }}</strong></div><div><small>工作区状态</small><strong class="status">{{ repo ? repo.dirty ? '有未提交改动' : '工作区干净' : '等待选择仓库' }}</strong></div></div>
          <div v-if="!state.workspaces.length" class="empty panel"><h2>还没有本地工作区</h2><p>克隆或导入仓库后可查看文件和改动。</p></div>
          <template v-else>
            <div class="workspace-bar"><select aria-label="选择工作区" :value="current || ''" :disabled="busy || gitBusy" @change="switchWorkspace($event.target.value)"><option value="" disabled>选择一个工作区</option><option v-for="item in state.workspaces" :key="item.id" :value="item.id">{{ item.name }} — {{ item.root }}</option></select><button :disabled="!active || busy || gitBusy" @click="refresh">↻ 刷新</button></div>
            <p v-if="active" class="root-path">{{ active.root }}</p>
            <div v-if="active" class="explorer panel">
              <section class="file-pane"><div class="pane-title"><h2>文件与目录</h2><span>按目录加载</span></div><div class="path-bar"><button :disabled="!relative || busy" @click="up">↑</button><span>{{ relative || '仓库根目录' }}</span></div>
                <div class="file-list"><button v-for="entry in entries" :key="entry.path" :class="['file-row', { selected: selected?.path === entry.path }]" :disabled="busy" @click="select(entry)" @dblclick="entry.directory && openDirectory(entry)"><span class="file-icon">{{ entry.directory ? '▰' : '▤' }}</span><span class="file-name">{{ entry.name }}<small v-if="state.notes[current]?.[entry.path]">{{ state.notes[current][entry.path] }}</small></span><span v-if="entry.directory" class="open-folder" @click.stop="openDirectory(entry)" role="button" aria-label="打开目录">›</span></button><p v-if="!entries.length" class="muted">此目录为空，或目录加载失败。</p><p v-if="truncated" class="muted">目录较大，仅展示前 1000 项。</p></div>
              </section>
              <section class="note-pane"><div class="pane-title"><h2>个人备注</h2><span class="local-tag">仅本机</span></div><template v-if="selected"><div class="selected-path">{{ selected.path }}</div><p>记录用途、阅读思路或待办，不会写入仓库。</p><textarea aria-label="个人备注" v-model="note" maxlength="4000" placeholder="例如：这里负责登录校验，修改前先确认接口字段…"></textarea><div class="note-footer"><small>{{ note.length }}/4000 {{ changed ? '· 尚未保存' : '' }}</small><button class="primary" :disabled="busy || !changed" @click="saveNote">保存备注</button></div></template><div v-else class="note-empty">选择左侧文件或目录<br><small>为它留下一条个人备注</small></div></section>
            </div><div v-else class="panel muted">请先从上方选择工作区。</div>
          </template>
          <GitPanel v-if="active" :key="active.id" :workspace="active" :scope="state.scope" :api="api" @pending="gitBusy = $event" @changed="updateFromGit" @configure-author="openAuthorSettings" />
          <div class="hint">ⓘ 备注按工作区与相对路径保存。文件移动或改名后，旧备注保留，新路径需重新填写。</div>
        </template>
        <template v-if="page === 'settings'"><div class="page-heading"><div><h1>设置</h1><p>连接共享服务并查看本机数据位置。</p></div></div><section class="panel settings"><h2>协作服务地址</h2><p>同一台电脑试用时填写 http://localhost:8080。更换地址会退出当前账号；连接其他电脑时请使用 HTTPS。</p><label for="server">服务地址</label><input id="server" v-model="serverUrl" placeholder="http://localhost:8080"><div class="button-line"><button class="primary" :disabled="busy" @click="saveAddress">保存设置</button><button :disabled="busy" @click="checkAddress">测试连接</button></div><hr><h2>本地数据</h2><p>工作区和备注仅保存在本机。离线数据（含 0.1 备注）与各协作账号的本机数据分开；退出即可回到原离线工作区。</p><code>{{ state.dataPath }}</code><p>关闭窗口即退出。下次启动协作项目时需要重新登录。</p></section></template>
        <template v-if="page === 'settings'">
          <div class="panel settings"><label for="author-workspace">配置 Git 作者的仓库</label><select id="author-workspace" :value="authorWorkspace?.id || ''" :disabled="gitBusy" @change="authorId = $event.target.value"><option value="" disabled>选择已导入的工作区</option><option v-for="item in state.workspaces" :key="item.id" :value="item.id">{{ item.name }} — {{ item.root }}</option></select></div>
          <GitPanel v-if="authorWorkspace" :key="authorWorkspace.id" :workspace="authorWorkspace" :scope="state.scope" :api="api" author-only @pending="gitBusy = $event" />
        </template>
        <Projects v-if="page === 'projects'" :user="state.user" :server-url="state.settings.serverUrl" :api="api" :sync-session="reload" :allow-switch="allowLeave" :scope="state.scope" :workspaces="state.workspaces" :git-bindings="state.gitBindings" :bind-git="bindGit" @pending="sharedBusy = $event" />
        <footer><span>协作工作台</span><span>{{ busy || sharedBusy ? '正在处理…' : state.user ? '已登录' : '离线模式' }}</span></footer>
      </div>
    </main>
  </div>
</template>
