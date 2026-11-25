<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({ workspace: Object, scope: String, api: Function });
const emit = defineEmits(['pending']);
const info = ref(null), busy = ref(false), error = ref(''), message = ref(''), progress = ref('');
const name = ref(''), email = ref(''), globalName = ref(''), globalEmail = ref('');
const remoteName = ref('');
const remote = computed(() => info.value?.remotes.find(item => item.name === remoteName.value));
const source = { global: '全局', local: '仓库', system: '系统', worktree: '工作树', command: '命令' };
const call = (operation, data) => props.api('gitSettings', props.scope, props.workspace?.id, operation, data);

async function load() {
  const result = await call('read');
  info.value = result;
  name.value = result.author?.name.value || '';
  email.value = result.author?.email.value || '';
  globalName.value = result.global.name;
  globalEmail.value = result.global.email;
  if (!result.remotes.some(item => item.name === remoteName.value)) {
    remoteName.value = result.remotes.find(item => item.name === 'origin')?.name || result.remotes[0]?.name || '';
  }
}
async function run(label, operation) {
  if (busy.value) return;
  busy.value = true;
  progress.value = label;
  message.value = '';
  error.value = '';
  emit('pending', true);
  try { await operation(); }
  catch (failure) { error.value = failure.message; }
  finally { busy.value = false; progress.value = ''; emit('pending', false); }
}
const update = (operation, data, result) => run('正在更新 Git 配置…', async () => {
  await call(operation, data);
  await load();
  message.value = result;
});
const login = () => run('请在默认浏览器完成 GitHub 授权…', async () => {
  await call('login');
  await load();
  message.value = '浏览器授权已完成。可以测试目标仓库的读取权限。';
});
const testRemote = () => run('正在测试远程仓库…', async () => {
  await call('test', { remote: remoteName.value });
  message.value = remoteName.value + ' 可以读取。此测试仅检查读取权限。';
});
const testSsh = () => run('正在检测 SSH 身份…', async () => {
  const result = await call('ssh-identity', { remote: remoteName.value });
  message.value = 'GitHub 识别到的 SSH 身份为 ' + result.account + '。';
});
watch(() => [props.scope, props.workspace?.id], () => {
  info.value = null;
  remoteName.value = '';
  run('正在读取 Git 设置…', load);
}, { immediate: true });
</script>

<template>
  <p v-if="progress" role="status" class="hint">{{ progress }}</p>
  <p v-if="error" role="alert" class="notice error">{{ error }}</p>
  <p v-if="message" role="status" class="notice success">{{ message }}</p>
  <button v-if="!info && !busy" type="button" @click="run('正在读取 Git 设置…', load)">重试检测</button>
  <template v-if="info">
    <p class="hint">{{ info.version }}</p>
    <details class="git-settings-group">
      <summary>全局提交身份</summary>
      <form class="collab-form" @submit.prevent="update('save-global', { name: globalName, email: globalEmail }, '全局提交身份已保存。')">
        <p class="hint">影响使用此账号的默认 Git 配置的仓库。</p>
        <label for="global-author-name">姓名</label>
        <input id="global-author-name" v-model.trim="globalName" :disabled="busy" required maxlength="100">
        <label for="global-author-email">邮箱</label>
        <input id="global-author-email" v-model.trim="globalEmail" :disabled="busy" required type="email" maxlength="200">
        <button :disabled="busy">保存全局身份</button>
      </form>
    </details>
    <details v-if="info.author" class="git-settings-group" open>
      <summary>当前仓库提交身份</summary>
      <form class="collab-form" @submit.prevent="update('save-local', { name, email }, '仓库提交身份已保存。')">
        <label for="author-name">姓名 <span class="hint">· {{ source[info.author.name.scope] || '未配置' }}</span></label>
        <input id="author-name" v-model.trim="name" :disabled="busy" required maxlength="100">
        <label for="author-email">邮箱 <span class="hint">· {{ source[info.author.email.scope] || '未配置' }}</span></label>
        <input id="author-email" v-model.trim="email" :disabled="busy" required type="email" maxlength="200">
        <div class="button-line">
          <button id="save-local-author" :disabled="busy">仅为此仓库保存</button>
          <button v-if="[info.author.name.scope, info.author.email.scope].includes('local')" type="button" :disabled="busy"
            @click="update('inherit', {}, '仓库提交身份已恢复继承。')">恢复使用全局配置</button>
        </div>
      </form>
    </details>
    <section class="git-settings-group">
      <h3>GitHub 身份</h3>
      <p class="hint" v-if="!info.manager">未检测到 Git Credential Manager。请通过 Git for Windows 安装后重新检测。</p>
      <p class="hint" v-else-if="info.accounts?.length">本机已保存的 HTTPS 账号：{{ info.accounts.join('、') }}</p>
      <p class="hint" v-else>{{ info.accounts ? '本机暂无已保存的 HTTPS 账号。' : '暂时无法读取本机已保存的 HTTPS 账号。' }}</p>
      <div class="button-line">
        <button type="button" :disabled="busy || !info.manager" @click="login">在浏览器登录 GitHub</button>
        <button type="button" :disabled="busy" @click="run('正在读取 Git 设置…', load)">刷新身份状态</button>
      </div>
    </section>
    <section v-if="workspace" class="git-settings-group">
      <h3>远程仓库连接</h3>
      <p v-if="!info.remotes.length" class="hint">此仓库尚未配置远程地址。</p>
      <div v-else class="collab-form">
        <label for="git-remote-test">远程</label>
        <select id="git-remote-test" v-model="remoteName" :disabled="busy" @change="message = ''; error = ''">
          <option v-for="item in info.remotes" :key="item.name" :value="item.name">{{ item.name }}</option>
        </select>
        <p v-if="remote" class="hint root-path" :title="remote.address">{{ remote.address || '远程地址无法安全显示，请在 Git 中核对。' }}</p>
        <div class="button-line">
          <button type="button" :disabled="busy || !remote?.address" @click="testRemote">测试读取权限</button>
          <button v-if="remote?.protocol === 'ssh'" type="button" :disabled="busy" @click="testSsh">检测 SSH 身份</button>
        </div>
      </div>
    </section>
  </template>
</template>
