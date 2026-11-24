<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import Tasks from './Tasks.vue';

const props = defineProps({
  user: Object, serverUrl: String, api: Function, syncSession: Function, allowSwitch: Function,
  scope: String, workspaces: Array, gitBindings: Object, bindGit: Function
});
const emit = defineEmits(['pending']);
const mode = ref('login');
const username = ref(''), displayName = ref(''), password = ref('');
const projects = ref([]), projectId = ref(null), members = ref([]), invitations = ref([]);
const newName = ref(''), inviteCode = ref(''), validHours = ref(24), issued = ref(null);
const busy = ref(false), error = ref(''), message = ref('');
const taskBusy = ref(false), view = ref('tasks'), projectForm = ref(null);
const pending = computed(() => busy.value || taskBusy.value);
const views = { tasks: '任务', members: '成员与仓库', activity: '动态' };
watch(pending, value => emit('pending', value));
const active = computed(() => projects.value.find(item => item.id === projectId.value));
const binding = computed(() => props.gitBindings[projectId.value]);
const boundWorkspace = computed(() => props.workspaces.find(item => item.id === binding.value?.workspaceId));
const roleLabel = role => role === 'OWNER' ? '组长' : '组员';
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
const call = (operation, data) => props.api('collaborate', operation, data);

function clearProjects() {
  projects.value = []; projectId.value = null; members.value = []; invitations.value = []; issued.value = null;
  taskBusy.value = false; view.value = 'tasks'; projectForm.value = null;
}
watch(() => props.user?.id, value => { if (!value) clearProjects(); });

async function run(action) {
  if (busy.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try { await action(); }
  catch (failure) {
    error.value = failure.message;
    if (failure.code === 'SESSION_EXPIRED') {
      clearProjects();
      try { await props.syncSession(); } catch (stateError) { error.value += ' ' + stateError.message; }
    }
  } finally { busy.value = false; }
}

async function openProject(id) {
  if (projectId.value !== id) { issued.value = null; view.value = 'tasks'; }
  projectId.value = id; members.value = []; invitations.value = [];
  if (!id || !active.value) return;
  members.value = await call('members', { projectId: id });
  if (active.value.role === 'OWNER') invitations.value = await call('invitations', { projectId: id });
}
async function refresh(preferred = projectId.value) {
  projects.value = await call('projects');
  await openProject(projects.value.some(item => item.id === preferred) ? preferred : projects.value[0]?.id);
}
function authenticate() {
  if (mode.value === 'login' && !props.allowSwitch()) return;
  return run(async () => {
    const data = { username: username.value, password: password.value };
    password.value = '';
    if (mode.value === 'register') {
      await call('register', { ...data, displayName: displayName.value });
      mode.value = 'login';
      message.value = '账号已创建，请输入密码登录。';
      return;
    }
    await call('login', data);
    await props.syncSession();
    await refresh();
  });
}
function signOut() {
  if (!props.allowSwitch()) return;
  return run(async () => {
    const result = await call('logout');
    clearProjects();
    await props.syncSession();
    message.value = result.remote ? '已退出登录。' : '已在本机退出；服务不可达，旧会话将自动过期。';
  });
}
const create = () => run(async () => {
  const project = await call('createProject', { name: newName.value });
  newName.value = '';
  projectForm.value = null;
  await refresh(project.id);
  message.value = '已创建私有项目。';
});
const join = () => run(async () => {
  const project = await call('join', { code: inviteCode.value });
  inviteCode.value = '';
  projectForm.value = null;
  await refresh(project.id);
  message.value = '已进入项目。';
});
const issue = () => run(async () => {
  issued.value = await call('issue', { projectId: projectId.value, validHours: Number(validHours.value) });
  invitations.value = await call('invitations', { projectId: projectId.value });
});
function bindWorkspace(id, select) {
  if (binding.value?.workspaceId === id) return;
  if (Object.keys(binding.value?.branches || {}).length && !window.confirm('更换项目仓库将清除本机的任务分支关联。继续吗？')) {
    select.value = binding.value.workspaceId;
    return;
  }
  const project = projectId.value;
  return run(async () => {
    try { await props.bindGit(project, id || null); }
    finally { select.value = binding.value?.workspaceId || ''; }
  });
}
const revoke = invitationId => run(async () => {
  await call('revoke', { projectId: projectId.value, invitationId });
  if (issued.value?.id === invitationId) issued.value = null;
  invitations.value = await call('invitations', { projectId: projectId.value });
  message.value = '邀请码已撤销，已加入的成员不受影响。';
});
onMounted(() => { if (props.user) run(() => refresh()); });
</script>

<template>
  <div class="collab">
    <div v-if="error" class="notice error" role="alert">{{ error }}</div>
    <div v-if="message" class="notice success" role="status">{{ message }}</div>
    <section v-if="!user" class="panel login-panel">
      <h2>{{ mode === 'login' ? '登录协作账号' : '注册协作账号' }}</h2>
      <p class="endpoint">协作服务 · {{ serverUrl }}</p>
      <form class="collab-form" @submit.prevent="authenticate">
        <label for="account-name">账号</label>
        <input id="account-name" v-model="username" required maxlength="32" autocomplete="username" placeholder="3–32 位英文、数字、点、下划线或短横线">
        <template v-if="mode === 'register'">
          <label for="display-name">显示名</label>
          <input id="display-name" v-model="displayName" required maxlength="48" autocomplete="nickname">
        </template>
        <label for="account-password">密码</label>
        <input id="account-password" v-model="password" required type="password" maxlength="72" :minlength="mode === 'register' ? 8 : undefined" :autocomplete="mode === 'register' ? 'new-password' : 'current-password'">
        <div class="button-line">
          <button type="submit" class="primary" :disabled="busy">{{ mode === 'login' ? '登录' : '创建账号' }}</button>
          <button type="button" :disabled="busy" @click="mode = mode === 'login' ? 'register' : 'login'; password = ''; error = ''; message = ''">{{ mode === 'login' ? '注册账号' : '返回登录' }}</button>
        </div>
      </form>
      <p>协作账号与 GitHub 账号独立。离线时仍可使用本地工作区。</p>
    </section>
    <template v-else>
      <div class="identity-line panel">
        <div><strong>{{ user.displayName }}</strong> <span>· @{{ user.username }}</span></div>
        <div class="button-line"><button :disabled="pending" @click="run(() => refresh())">刷新项目与成员</button>
          <button :disabled="pending" @click="signOut">退出登录</button></div>
      </div>
      <div class="project-grid">
        <section class="panel project-list">
          <h2>我的私有项目</h2>
          <p v-if="!projects.length">暂无项目。可自行创建，或使用组长发给你的邀请码。</p>
          <div v-else class="project-choices">
            <button v-for="project in projects" :key="project.id" type="button" :class="['project-choice', { 'current-project': project.id === projectId }]" :aria-pressed="project.id === projectId" :disabled="pending" @click="run(() => openProject(project.id))">
              <span>{{ project.name }}</span><small>{{ roleLabel(project.role) }}</small>
            </button>
          </div>
          <div class="button-line project-actions">
            <button id="show-create-project" :aria-expanded="projectForm === 'create'" :disabled="pending" @click="projectForm = projectForm === 'create' ? null : 'create'">新建项目</button>
            <button id="show-join-project" :aria-expanded="projectForm === 'join'" :disabled="pending" @click="projectForm = projectForm === 'join' ? null : 'join'">使用邀请码</button>
          </div>
          <form v-if="projectForm === 'create'" class="collab-form" @submit.prevent="create">
            <label for="new-project">项目名称</label>
            <input id="new-project" v-model.trim="newName" required maxlength="80" placeholder="项目名称">
            <button type="submit" class="primary" :disabled="pending">创建项目</button>
          </form>
          <form v-if="projectForm === 'join'" class="collab-form" @submit.prevent="join">
            <label for="join-code">邀请码</label>
            <input id="join-code" v-model.trim="inviteCode" required maxlength="128" placeholder="粘贴组长提供的邀请码">
            <button type="submit" class="primary" :disabled="pending">加入项目</button>
          </form>
        </section>
        <section v-if="active" class="project-detail">
          <div class="project-header panel">
            <div class="project-title"><h2>{{ active.name }}</h2><span class="badge">{{ roleLabel(active.role) }}</span></div>
            <nav class="view-tabs" aria-label="项目视图">
              <button v-for="(label, key) in views" :id="'project-' + key + '-view'" :key="key" :aria-pressed="view === key" :disabled="pending" @click="view = key">{{ label }}</button>
            </nav>
          </div>
          <section v-if="view === 'members'" class="panel project-members">
          <h3>本机仓库</h3>
          <div class="collab-form">
            <label for="project-repo">工作区</label>
            <select id="project-repo" :value="binding?.workspaceId || ''" :disabled="pending" @change="bindWorkspace($event.target.value, $event.target)">
              <option value="">尚未绑定</option><option v-for="item in workspaces" :key="item.id" :value="item.id">{{ item.name }} — {{ item.root }}</option>
            </select>
            <p v-if="!workspaces.length" class="hint">请先在当前账号的本地工作区克隆或导入仓库。</p>
          </div>
          <h3>项目成员</h3>
          <ul class="member-list">
            <li v-for="member in members" :key="member.id"><span>{{ member.displayName }} <small>@{{ member.username }}</small></span><span>{{ roleLabel(member.role) }}</span><button v-if="active.role==='OWNER' && member.role!=='OWNER'" :disabled="busy" @click="run(async()=>{const reason=window.prompt('移除成员原因（先处理其未完成任务）');if(!reason?.trim())return;await call('removeMember',{projectId:active.id,memberId:member.id,reason});await refresh();})">移除</button></li>
          </ul>
          <p v-if="!members.length && !busy">尚未取得成员列表，可点击刷新。</p>
          <template v-if="active.role === 'OWNER'">
            <form class="collab-form" @submit.prevent="issue">
              <label for="invite-hours">邀请码有效期（小时）</label>
              <div class="button-line">
                <input id="invite-hours" v-model.number="validHours" type="number" min="1" max="168" required>
                <button type="submit" class="primary" :disabled="busy">生成邀请码</button>
              </div>
            </form>
            <div v-if="issued" class="issued-code">
              <label for="issued-code">本次生成的邀请码</label>
              <input id="issued-code" :value="issued.code" readonly @focus="$event.target.select()">
              <p>选中后按 Ctrl+C 复制，明文只显示这一次。到期：{{ date(issued.expiresAt) }}</p>
            </div>
            <h3>已生成的邀请</h3>
            <ul class="member-list">
              <li v-for="invite in invitations" :key="invite.id">
                <span>{{ invite.revokedAt ? '已撤销' : Date.parse(invite.expiresAt) <= Date.now() ? '已过期' : '有效' }} <small>到期 {{ date(invite.expiresAt) }}</small></span>
                <button v-if="!invite.revokedAt && Date.parse(invite.expiresAt) > Date.now()" type="button" :disabled="busy" @click="revoke(invite.id)">撤销</button>
              </li>
            </ul>
          </template>
          </section>
          <Tasks v-if="active" v-show="view !== 'members'" :key="active.id" :view="view" :project="active" :user="user" :members="members" :api="api" :scope="scope" :workspace="boundWorkspace" :branches="binding?.branches" :bind-git="bindGit" @pending="taskBusy = $event" @expired="async()=>{clearProjects();await syncSession()}" />
        </section>
        <section v-else class="panel empty"><h2>选择或加入项目</h2><p>在左侧创建新项目，或者使用组长发给你的邀请码。</p></section>
      </div>
    </template>
  </div>
</template>
