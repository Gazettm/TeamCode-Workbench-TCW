<script setup>
import { computed, onMounted, ref, watch } from 'vue';

const props = defineProps({
  user: Object, serverUrl: String, api: Function, syncSession: Function, allowSwitch: Function
});
const emit = defineEmits(['pending']);
const mode = ref('login');
const username = ref(''), displayName = ref(''), password = ref('');
const projects = ref([]), projectId = ref(null), members = ref([]), invitations = ref([]);
const newName = ref(''), inviteCode = ref(''), validHours = ref(24), issued = ref(null);
const busy = ref(false), error = ref(''), message = ref('');
const active = computed(() => projects.value.find(item => item.id === projectId.value));
const roleLabel = role => role === 'OWNER' ? '组长' : '组员';
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
const call = (operation, data) => props.api('collaborate', operation, data);

function clearProjects() {
  projects.value = []; projectId.value = null; members.value = []; invitations.value = []; issued.value = null;
}
watch(() => props.user?.id, value => { if (!value) clearProjects(); });

async function run(action) {
  if (busy.value) return;
  busy.value = true; emit('pending', true); error.value = ''; message.value = '';
  try { await action(); }
  catch (failure) {
    error.value = failure.message;
    if (failure.code === 'SESSION_EXPIRED') {
      clearProjects();
      try { await props.syncSession(); } catch (stateError) { error.value += ' ' + stateError.message; }
    }
  } finally { busy.value = false; emit('pending', false); }
}

async function openProject(id) {
  if (projectId.value !== id) issued.value = null;
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
  await refresh(project.id);
  message.value = '已创建私有项目。';
});
const join = () => run(async () => {
  const project = await call('join', { code: inviteCode.value });
  inviteCode.value = '';
  await refresh(project.id);
  message.value = '已进入项目。';
});
const issue = () => run(async () => {
  issued.value = await call('issue', { projectId: projectId.value, validHours: Number(validHours.value) });
  invitations.value = await call('invitations', { projectId: projectId.value });
});
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
    <div class="page-heading">
      <div><h1>协作项目</h1><p>{{ user ? '切换项目、查看成员或邀请组员加入。' : '登录同一个协作服务后，才能访问团队项目。' }}</p></div>
      <button v-if="user" :disabled="busy" @click="signOut">退出登录</button>
    </div>
    <div v-if="error" class="notice error" role="alert">{{ error }}</div>
    <div v-if="message" class="notice success" role="status">{{ message }}</div>
    <section v-if="!user" class="panel login-panel">
      <h2>{{ mode === 'login' ? '登录' : '注册' }}</h2>
      <p class="endpoint">{{ serverUrl }}</p>
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
      <div class="workspace-bar identity-line">
        <div><strong>{{ user.displayName }}</strong> <span>· @{{ user.username }}</span></div>
        <button :disabled="busy" @click="run(() => refresh())">刷新项目与成员</button>
      </div>
      <div class="project-grid">
        <section class="panel project-list">
          <h2>我的私有项目</h2>
          <p v-if="!projects.length">暂无项目。可自行创建，或使用组长发给你的邀请码。</p>
          <button v-for="project in projects" :key="project.id" type="button" :class="['project-choice', { 'current-project': project.id === projectId }]" :disabled="busy" @click="run(() => openProject(project.id))">
            <span>{{ project.name }}</span><small>{{ roleLabel(project.role) }}</small>
          </button>
          <form class="collab-form" @submit.prevent="create">
            <label for="new-project">创建私有项目</label>
            <input id="new-project" v-model.trim="newName" required maxlength="80" placeholder="项目名称">
            <button type="submit" class="primary" :disabled="busy">创建项目</button>
          </form>
          <form class="collab-form" @submit.prevent="join">
            <label for="join-code">使用邀请码加入</label>
            <input id="join-code" v-model.trim="inviteCode" required maxlength="128" placeholder="粘贴组长提供的邀请码">
            <button type="submit" :disabled="busy">加入项目</button>
          </form>
        </section>
        <section v-if="active" class="panel project-detail">
          <div class="project-title"><h2>{{ active.name }}</h2><span class="badge">{{ roleLabel(active.role) }}</span></div>
          <h3>项目成员</h3>
          <ul class="member-list">
            <li v-for="member in members" :key="member.id"><span>{{ member.displayName }} <small>@{{ member.username }}</small></span><span>{{ roleLabel(member.role) }}</span></li>
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
          <p class="task-placeholder">0.2 支持账号和项目成员。任务看板将在 0.3 加入。</p>
        </section>
        <section v-else class="panel"><p>创建、加入或选择一个项目后，即可查看成员。</p></section>
      </div>
    </template>
  </div>
</template>
