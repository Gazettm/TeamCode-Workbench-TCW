<script setup>
import { ref, computed, onMounted } from 'vue';
const page = ref('workspace');
const state = ref({ workspaces: [], notes: {}, settings: { serverUrl: 'http://localhost:8080' } });
const current = ref(null), entries = ref([]), relative = ref(''), selected = ref(null), note = ref(''), savedNote = ref('');
const repo = ref(null), busy = ref(false), error = ref(''), message = ref(''), ready = ref(false), serverUrl = ref(''), truncated = ref(false);
const active = computed(() => state.value.workspaces.find(item => item.id === current.value));
const changed = computed(() => note.value !== savedNote.value);
const api = async (method, ...args) => {
  if (!window.tcw) throw new Error('请通过 Electron 客户端启动，此页面不支持独立浏览器操作');
  const response = await window.tcw[method](...args);
  if (!response.ok) throw new Error(response.error);
  return response.data;
};
async function run(action) {
  if (busy.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try { await action(); } catch (e) { error.value = e.message; } finally { busy.value = false; }
}
function allowLeave() { return !changed.value || window.confirm('备注尚未保存，确定放弃这次修改吗？'); }
async function loadDirectory(target = '') {
  const result = await api('list', current.value, target);
  relative.value = target; entries.value = result.entries; truncated.value = result.truncated;
}
async function switchWorkspace(id) {
  if (!allowLeave()) return;
  await run(async () => {
    current.value = id; selected.value = null; note.value = ''; savedNote.value = ''; entries.value = []; relative.value = ''; repo.value = null;
    repo.value = await api('status', id); await loadDirectory();
  });
}
async function importWorkspace() {
  if (!allowLeave()) return;
  let imported;
  await run(async () => {
    imported = await api('importWorkspace');
    if (imported) { state.value = await api('bootstrap'); serverUrl.value = state.value.settings.serverUrl; }
  });
  if (imported) await switchWorkspace(imported.id);
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
    await api('saveNote', current.value, selected.value.path, snapshot);
    state.value = await api('bootstrap'); savedNote.value = snapshot; message.value = changed.value ? '上一次备注已保存；当前输入还有新修改' : '备注已保存到本机';
  });
}
async function refresh() {
  await run(async () => { repo.value = await api('status', current.value); await loadDirectory(relative.value); message.value = '仓库状态已刷新'; });
}
onMounted(async () => {
  await run(async () => { state.value = await api('bootstrap'); serverUrl.value = state.value.settings.serverUrl; });
  ready.value = true;
});
window.addEventListener('beforeunload', event => { if (changed.value) { event.preventDefault(); event.returnValue = ''; } });
</script>

<template>
  <div class="shell" :data-ready="ready">
    <aside class="sidebar">
      <div class="brand"><span class="logo">T</span><div>协作工作台<small>TEAMCODE WORKBENCH</small></div></div>
      <div class="nav-label">工作空间</div>
      <button :class="['nav', { active: page === 'workspace' }]" @click="page = 'workspace'">▦ <span>本地工作区</span></button>
      <button :class="['nav', { active: page === 'roadmap' }]" @click="page = 'roadmap'">◷ <span>协作与任务</span><small>即将推出</small></button>
      <div class="sidebar-bottom"><button :class="['nav', { active: page === 'settings' }]" @click="page = 'settings'">⚙ <span>设置</span></button><div class="version">LOCAL FIRST <span>v0.1.0</span></div></div>
    </aside>
    <main>
      <header><div class="breadcrumb">协作工作台 <span>/</span> {{ page === 'workspace' ? '本地工作区' : page === 'settings' ? '设置' : '协作与任务' }}</div><span class="badge">本地基础版 · 0.1</span></header>
      <div class="content">
        <div v-if="error" class="notice error" role="alert">{{ error }}</div><div v-if="message" class="notice success" role="status">{{ message }}</div>
        <template v-if="page === 'workspace'">
          <div class="page-heading"><div><div class="eyebrow">YOUR LOCAL WORKSPACE</div><h1>本地工作区</h1><p>从已有仓库开始，让代码与个人思路井然有序。</p></div><button class="primary" :disabled="busy" @click="importWorkspace">＋ 导入 Git 仓库</button></div>
          <div class="stats"><div><small>已导入工作区</small><strong>{{ state.workspaces.length.toString().padStart(2, '0') }}</strong></div><div><small>当前分支</small><strong class="branch">{{ repo?.branch || '—' }}</strong></div><div><small>工作区状态</small><strong class="status">{{ repo ? repo.dirty ? '有未提交改动' : '工作区干净' : '等待选择仓库' }}</strong></div></div>
          <div v-if="!state.workspaces.length" class="empty panel"><div class="folder-icon">▱</div><h2>把你的第一个仓库带进来</h2><p>选择本机已有的 Git 仓库，浏览目录并添加只属于你的文件备注。</p><button class="primary" :disabled="busy" @click="importWorkspace">选择本地仓库</button><small>0.1 只读取 Git 状态，不会提交、推送或修改仓库文件。</small></div>
          <template v-else>
            <div class="workspace-bar"><select aria-label="选择工作区" :value="current || ''" :disabled="busy" @change="switchWorkspace($event.target.value)"><option value="" disabled>选择一个工作区</option><option v-for="item in state.workspaces" :key="item.id" :value="item.id">{{ item.name }} — {{ item.root }}</option></select><button :disabled="!active || busy" @click="refresh">↻ 刷新</button></div>
            <p v-if="active" class="root-path">{{ active.root }}</p>
            <div v-if="active" class="explorer panel">
              <section class="file-pane"><div class="pane-title"><h2>文件与目录</h2><span>按目录加载</span></div><div class="path-bar"><button :disabled="!relative || busy" @click="up">↑</button><span>{{ relative || '仓库根目录' }}</span></div>
                <div class="file-list"><button v-for="entry in entries" :key="entry.path" :class="['file-row', { selected: selected?.path === entry.path }]" :disabled="busy" @click="select(entry)" @dblclick="entry.directory && openDirectory(entry)"><span class="file-icon">{{ entry.directory ? '▰' : '▤' }}</span><span class="file-name">{{ entry.name }}<small v-if="state.notes[current]?.[entry.path]">{{ state.notes[current][entry.path] }}</small></span><span v-if="entry.directory" class="open-folder" @click.stop="openDirectory(entry)" role="button" aria-label="打开目录">›</span></button><p v-if="!entries.length" class="muted">此目录为空，或目录加载失败。</p><p v-if="truncated" class="muted">目录较大，仅展示前 1000 项。</p></div>
              </section>
              <section class="note-pane"><div class="pane-title"><h2>个人备注</h2><span class="local-tag">仅本机</span></div><template v-if="selected"><div class="selected-path">{{ selected.path }}</div><p>记录用途、阅读思路或待办，不会写入仓库。</p><textarea aria-label="个人备注" v-model="note" maxlength="4000" placeholder="例如：这里负责登录校验，修改前先确认接口字段…"></textarea><div class="note-footer"><small>{{ note.length }}/4000 {{ changed ? '· 尚未保存' : '' }}</small><button class="primary" :disabled="busy || !changed" @click="saveNote">保存备注</button></div></template><div v-else class="note-empty">选择左侧文件或目录<br><small>为它留下一条个人备注</small></div></section>
            </div><div v-else class="panel muted">请先从上方选择工作区。</div>
          </template>
          <div class="hint">ⓘ 备注按工作区与相对路径保存。文件移动或改名后，旧备注保留，新路径需重新填写。</div>
        </template>
        <template v-if="page === 'settings'"><div class="page-heading"><div><div class="eyebrow">PREFERENCES</div><h1>设置</h1><p>管理本机配置，为后续协作服务做好准备。</p></div></div><section class="panel settings"><h2>协作服务地址</h2><p>保存后将在后续版本用于连接共享服务。0.1 尚未连接后端，不会发出网络请求。</p><label for="server">服务地址</label><input id="server" v-model="serverUrl" placeholder="http://localhost:8080"><button class="primary" :disabled="busy" @click="run(async () => { state.settings = await api('saveSettings', serverUrl); serverUrl = state.settings.serverUrl; message = '设置已保存；当前版本尚未连接服务'; })">保存设置</button><hr><h2>本地数据</h2><p>工作区列表、个人备注与设置保存在当前 Windows 用户的应用数据目录中，不上传、不默认进入 Git。</p><code>{{ state.dataPath }}</code><p>当前无系统账号登录，数据隔离依赖 Windows 用户。关闭窗口即退出，托盘后台运行尚未实现。</p></section></template>
        <template v-if="page === 'roadmap'"><div class="page-heading"><div><div class="eyebrow">COMING NEXT</div><h1>协作与任务</h1><p>从本地基础能力，逐步走向团队协作。</p></div></div><div class="panel roadmap"><span class="badge">规划中，尚未实现</span><h2>共享协作从 0.2 开始</h2><p>当前版本没有登录、共享项目或任务数据，不展示虚构的团队进度。</p><ol><li><strong>0.2 · 身份与项目</strong><p>Spring Boot + MySQL，注册登录、私有项目与邀请。</p></li><li><strong>0.3 · 任务与验收</strong><p>单负责人、领取、提交、组长验收与动态。</p></li><li><strong>0.4 及以后 · Git 与 AI</strong><p>克隆、分支、选择提交、推送与受限拉取；AI 后续接入。</p></li></ol></div></template>
        <footer><span>TCW · 让协作从清晰开始</span><span>{{ busy ? '正在处理…' : '本地模式' }}</span></footer>
      </div>
    </main>
  </div>
</template>
