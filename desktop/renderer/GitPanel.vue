<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({ workspace: Object, scope: String, api: Function });
const emit = defineEmits(['pending', 'changed', 'configure-author']);
const info = ref(null), error = ref(''), message = ref(''), busy = ref(false);
const branch = ref(''), newBranch = ref(''), authError = ref(false);
const branchTools = ref(null), newBranchInput = ref(null);
const files = ref([]), summary = ref(''), preview = ref(null);
const moreTools = ref(null), chooseDeletion = ref(false), branchToDelete = ref('');
const deletableBranches = computed(() => info.value?.branches.filter(name => name !== info.value.branch) || []);
const alignUnavailable = computed(() => {
  const data = info.value;
  if (data?.inProgress) return '请先完成仓库里正在进行的 Git 操作。';
  if (!data?.branch || !data.head || !data.upstream?.ref.startsWith('refs/remotes/')) return '请切换到已设置远程上游的本地分支。';
  if (data.staged) return '请先提交或取消暂存，再对齐分支。';
  return '';
});
const previewLines = computed(() => preview.value?.text.split('\n') || []);
const eligible = computed(() => info.value?.files.filter(file => file.selectable) || []);
const missingAuthor = computed(() => info.value && (!info.value.author.name || !info.value.author.email));
const suggestNewBranch = computed(() => info.value?.head && ['main', 'master'].includes(info.value.branch));
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
  branch.value = data.branch;
  if (preview.value && !data.files.some(item => item.path === preview.value.path)) preview.value = null;
}
async function run(action) {
  if (busy.value) return;
  busy.value = true;
  emit('pending', true);
  error.value = '';
  authError.value = false;
  message.value = '';
  try { await action(); }
  catch (e) { error.value = e.message; authError.value = e.code === 'GIT_AUTH'; }
  finally { busy.value = false; emit('pending', false); }
}
const write = (kind, fields) => run(async () => {
  const result = await call(kind, { branch: info.value.branch, head: info.value.head, ...fields }).catch(async error => {
    if (kind === 'align') await load().catch(() => {});
    throw error;
  });
  if (result.canceled) {
    if (kind === 'align') await load();
    return;
  }
  if (kind === 'commit') { summary.value = ''; files.value = []; }
  if (kind === 'createBranch') newBranch.value = '';
  preview.value = null;
  await load();
  emit('changed');
  message.value = {
    push: '推送成功。', fetch: '远程状态已获取。', pull: '快进检查完成。', commit: '本地提交已创建。',
    createBranch: '已切换到新分支 ' + info.value.branch + '。',
    align: result.alreadyAligned ? '当前分支已与上游一致。' :
      '已对齐到远程分支。' + (result.backup ? '原提交保存在 ' + result.backup + '。' : ''),
    deleteBranch: '已删除本地分支 ' + fields?.target + '。',
    forceDeleteBranch: '已强制删除本地分支 ' + fields?.target + '。'
  }[kind] || '操作已保存。';
});
function openNewBranch() {
  branchTools.value.open = true;
  newBranchInput.value.focus();
}
function closeMore() {
  if (!moreTools.value?.open) return;
  moreTools.value.open = false;
  moreTools.value.querySelector('summary').focus();
}
function runMore(kind, fields) {
  closeMore();
  chooseDeletion.value = false;
  branchToDelete.value = '';
  return write(kind, fields);
}
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
  <section class="git-panel">
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <button v-if="authError" type="button" @click="emit('configure-author')">打开 Git 与 GitHub 设置</button>
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
            <details ref="moreTools" class="git-more" @keydown.esc.stop="closeMore">
              <summary>更多 <span aria-hidden="true">▾</span></summary>
              <div class="git-more-panel">
                <button id="git-align-remote" :disabled="busy || !!alignUnavailable"
                  @click="runMore('align')">对齐到远程分支</button>
                <p v-if="alignUnavailable" class="hint">{{ alignUnavailable }}</p>
                <button id="git-show-delete" :aria-expanded="chooseDeletion" :disabled="busy || info.inProgress || !deletableBranches.length" @click="chooseDeletion = !chooseDeletion">删除本地分支</button>
                <form v-if="chooseDeletion" class="collab-form git-delete-form" @submit.prevent="runMore('deleteBranch', { target: branchToDelete })">
                  <label for="git-branch-to-delete">要删除的本地分支</label>
                  <select id="git-branch-to-delete" v-model="branchToDelete" :disabled="busy" required>
                    <option value="" disabled>选择分支</option>
                    <option v-for="name in deletableBranches" :key="name">{{ name }}</option>
                  </select>
                  <div class="button-line">
                    <button type="submit" :disabled="busy || !deletableBranches.includes(branchToDelete)">继续删除</button>
                    <button type="button" class="danger" :disabled="busy || !deletableBranches.includes(branchToDelete)" @click="runMore('forceDeleteBranch', { target: branchToDelete })">强制删除</button>
                  </div>
                </form>
              </div>
            </details>
          </div>
        </div>
        <p v-if="info.inProgress" class="hint">仓库正在合并、变基或处理冲突，请先在终端完成。</p>
        <fieldset :disabled="busy || info.inProgress">
        <details ref="branchTools" class="branch-tools">
          <summary>切换或创建分支</summary>
        <div class="git-controls">
          <div><label>本地分支 <select v-model="branch"><option value="" disabled>选择分支</option><option v-for="name in info.branches" :key="name">{{ name }}</option></select></label>
            <button :disabled="!branch || branch === info.branch || info.dirty" @click="write('switch', { target: branch })">切换分支</button></div>
          <div><label>新分支 <input ref="newBranchInput" v-model.trim="newBranch" maxlength="120"></label>
            <button :disabled="!newBranch || !info.head" @click="write('createBranch', { target: newBranch })">创建并切换</button></div>
        </div>
        <p v-if="info.dirty && info.head" class="hint">创建新分支会保留未提交的改动。</p>
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
          <p v-if="info.branch" class="hint">将提交到本地分支 <strong>{{ info.branch }}</strong></p>
          <p v-if="commitHint" id="git-commit-hint" class="hint">{{ commitHint }}</p>
          <div class="button-line">
            <button v-if="suggestNewBranch" type="button" class="primary" @click="openNewBranch">先创建分支</button>
            <button :class="{ primary: !suggestNewBranch }" :disabled="!!commitHint" :aria-describedby="commitHint ? 'git-commit-hint' : undefined">提交选中的 {{ files.length }} 个文件</button>
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
