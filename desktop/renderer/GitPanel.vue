<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({ workspace: Object, scope: String, api: Function, authorOnly: Boolean });
const emit = defineEmits(['pending', 'changed', 'configure-author']);
const info = ref(null), error = ref(''), message = ref(''), busy = ref(false);
const authorName = ref(''), email = ref(''), branch = ref(''), newBranch = ref('');
const files = ref([]), summary = ref(''), preview = ref(null);
const previewLines = computed(() => preview.value?.text.split('\n') || []);
const eligible = computed(() => info.value?.files.filter(file => file.selectable) || []);
const missingAuthor = computed(() => info.value && (!info.value.author.name || !info.value.author.email));
const commitHint = computed(() => [
  info.value.inProgress && '请先处理仓库里的合并、变基或冲突。',
  !info.value.branch && '请切换到本地分支。',
  missingAuthor.value && '请配置此仓库的 Git 姓名和邮箱。',
  !files.value.length && '请勾选要提交的文件。',
  !summary.value.trim() && '请填写提交说明。'
].filter(Boolean).join(' '));

function statusLabel(status) {
  if (status === '??') return '未跟踪';
  if (/U|^AA$|^DD$/.test(status)) return '冲突';
  const labels = { M: '已修改', A: '已添加', D: '已删除', T: '类型变更', R: '已重命名', C: '已复制' };
  return [...new Set(status.trim())].map(code => labels[code] || code).join(' · ');
}

const call = (kind, input = {}) => props.api('git', props.scope, props.workspace.id, kind, input);
async function load() {
  const data = await call('read');
  info.value = data;
  files.value = files.value.filter(path => data.files.some(item => item.selectable && item.path === path));
  authorName.value = data.author.name;
  email.value = data.author.email;
  branch.value = data.branch;
  if (preview.value && !data.files.some(item => item.path === preview.value.path)) preview.value = null;
}
async function run(action) {
  if (busy.value) return;
  busy.value = true;
  emit('pending', true);
  error.value = '';
  message.value = '';
  try { await action(); }
  catch (e) { error.value = e.message; }
  finally { busy.value = false; emit('pending', false); }
}
const write = (kind, fields) => run(async () => {
  const result = await call(kind, { branch: info.value.branch, head: info.value.head, ...fields });
  if (result.canceled) return;
  if (kind === 'commit') { summary.value = ''; files.value = []; }
  if (kind === 'createBranch') newBranch.value = '';
  preview.value = null;
  await load();
  emit('changed');
  message.value = { push: '推送成功。', fetch: '远程状态已获取。', pull: '快进检查完成。', commit: '本地提交已创建。' }[kind] || '操作已保存。';
});
const showDiff = file => run(async () => {
  preview.value = { path: file.path, isDiff: file.status !== '??', text: await call('diff', { path: file.path }) };
});
function diffLineClass(line) {
  if (!preview.value?.isDiff) return undefined;
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+') && !line.startsWith('+++ ')) return 'diff-add';
  if (line.startsWith('-') && !line.startsWith('--- ')) return 'diff-remove';
}
watch(() => props.workspace.id, () => run(load), { immediate: true });
</script>

<template>
  <section v-if="authorOnly" class="git-author-editor">
    <p class="root-path" :title="workspace.root">{{ workspace.root }}</p>
    <p>这两项会写入此仓库的提交记录。访问远程仓库使用本机 Git 凭据或 SSH 密钥。</p>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="message" class="notice success" role="status">{{ message }}</p>
    <form v-if="info" class="collab-form" @submit.prevent="write('author', { name: authorName, email })">
      <label for="author-name">Git 姓名</label><input id="author-name" v-model.trim="authorName" maxlength="100" required>
      <label for="author-email">Git 邮箱</label><input id="author-email" v-model.trim="email" type="email" maxlength="200" required>
      <button class="primary" :disabled="busy">保存 Git 作者</button>
    </form>
  </section>
  <section v-else class="git-panel">
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <p v-if="message" class="notice success" role="status">{{ message }}</p>
    <div v-if="!info" class="panel empty">
      <p v-if="busy">正在读取 Git 状态…</p>
      <button v-else @click="run(load)">重试读取</button>
    </div>
    <template v-if="info">
      <section class="panel git-remote">
        <div class="section-bar git-remote-header">
          <div>
            <h2>分支与远程</h2>
            <div class="git-ref">当前 <strong id="git-current-branch">{{ info.branch || '分离 HEAD' }}</strong>
              <span>{{ info.upstream ? '上游 ' + info.upstream.remote + '/' + (info.upstream.destination || info.upstream.ref).replace('refs/heads/', '') : '暂无上游' }}</span>
              <span v-if="info.ahead !== null" class="pill" title="与最近获取的远程提交比较">领先 {{ info.ahead }} · 落后 {{ info.behind }}</span>
            </div>
          </div>
          <div class="button-line">
            <button :disabled="busy" @click="run(load)">刷新 Git 状态</button>
            <button :disabled="busy || info.inProgress || !info.branch || !info.head || (!info.upstream && !info.hasOrigin)" @click="write('fetch')">获取远程状态</button>
            <button :disabled="busy || info.inProgress || !info.branch || !info.head || !info.upstream || info.dirty" @click="write('pull')">快进更新</button>
            <button :disabled="busy || info.inProgress || !info.branch || !info.head || (!info.upstream && !info.hasOrigin)" @click="write('push')">推送</button>
          </div>
        </div>
        <p v-if="info.inProgress" class="hint">仓库正在合并、变基或处理冲突，请先在终端完成。</p>
        <fieldset :disabled="busy || info.inProgress">
        <details class="branch-tools">
          <summary>切换或创建分支</summary>
        <div class="git-controls">
          <div><label>本地分支 <select v-model="branch"><option value="" disabled>选择分支</option><option v-for="name in info.branches" :key="name">{{ name }}</option></select></label>
            <button :disabled="!branch || branch === info.branch || info.dirty" @click="write('switch', { target: branch })">切换分支</button></div>
          <div><label>新分支 <input v-model.trim="newBranch" maxlength="120"></label>
            <button :disabled="!newBranch || !info.head || info.dirty" @click="write('createBranch', { target: newBranch })">从当前提交创建</button></div>
        </div>
        </details>
        </fieldset>
      </section>
      <div class="git-review-layout">
      <section class="panel git-changes">
      <fieldset :disabled="busy || info.inProgress">
        <div class="task-heading git-file-heading">
          <h2>工作区改动</h2><span class="pill">{{ info.changeCount }} 项</span>
        </div>
        <div v-if="eligible.length" class="button-line git-selection">
            <span>已选 {{ files.length }} 项</span>
            <button type="button" @click="files = eligible.slice(0, info.commitLimit).map(file => file.path)">
              {{ eligible.length > info.commitLimit ? '选择前 ' + info.commitLimit + ' 项' : '全选' }}
            </button>
            <button type="button" :disabled="!files.length" @click="files = []">取消全选</button>
        </div>
        <p v-if="!info.files.length">工作区干净。</p>
        <p v-if="info.truncated" class="hint">这里只显示前 1000 项。</p>
        <p v-if="eligible.length > info.commitLimit" class="hint">每次最多提交 {{ info.commitLimit }} 个文件，可分批选择。</p>
        <div v-if="info.files.length" class="git-files">
          <div v-for="file in info.files" :key="file.path" :class="['git-file', { 'file-previewed': preview?.path === file.path }]">
            <input v-model="files" type="checkbox" :aria-label="'选择 ' + file.path" :value="file.path" :disabled="!file.selectable || (files.length >= info.commitLimit && !files.includes(file.path))">
            <button class="diff-choice" :disabled="!file.selectable" :aria-pressed="preview?.path === file.path" @click="showDiff(file)">
              <span class="git-file-path" :title="file.path">{{ file.path }}</span>
              <span class="git-file-state" :title="file.status.trim()">{{ statusLabel(file.status) }}</span>
            </button>
          </div>
        </div>
        <form v-if="info.files.length" class="collab-form" @submit.prevent="write('commit', { paths: Array.from(files), message: summary })">
          <label for="commit-message">提交说明（必填）</label><textarea id="commit-message" v-model.trim="summary" maxlength="1000" required></textarea>
          <p v-if="commitHint" id="git-commit-hint" class="hint">{{ commitHint }}</p>
          <div class="button-line">
            <button class="primary" :disabled="!!commitHint" :aria-describedby="commitHint ? 'git-commit-hint' : undefined">提交选中的 {{ files.length }} 个文件</button>
            <button v-if="missingAuthor" type="button" @click="emit('configure-author')">配置 Git 作者</button>
          </div>
        </form>
      </fieldset>
      </section>
      <section class="panel diff-panel" aria-label="文件差异">
        <div class="pane-title"><h2>{{ preview && !preview.isDiff ? '文件预览' : '文件差异' }}</h2><button v-if="preview" :disabled="busy" @click="preview = null">关闭预览</button></div>
        <div v-if="preview" class="diff-content">
          <div class="selected-path">{{ preview.path }}</div>
          <pre tabindex="0"><span v-for="(line, index) in previewLines" :key="index" :class="diffLineClass(line)">{{ line || ' ' }}</span></pre>
        </div>
        <div v-else class="note-empty"><strong>{{ info.files.length ? '选择一个改动文件' : '暂无差异' }}</strong><p v-if="info.files.length">点击文件名查看内容，勾选左侧复选框准备提交。</p></div>
      </section>
      </div>
    </template>
  </section>
</template>
