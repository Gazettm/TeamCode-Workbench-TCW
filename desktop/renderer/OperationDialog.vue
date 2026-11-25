<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({ request: Object });
const emit = defineEmits(['decision']);
const modal = ref(null), cancelButton = ref(null), backup = ref(false);
const labels = {
  align: '对齐分支', clone: '克隆仓库', push: '推送分支', pull: '快进更新',
  author: '保存提交身份', commit: '提交文件', switch: '切换分支', createBranch: '创建并切换',
  deleteBranch: '删除分支', forceDeleteBranch: '强制删除',
  accept: '验收通过', return: '退回任务', assign: '重新指派', deadline: '调整截止',
  cancel: '取消任务', delegate: '委派复核', 'revoke-review': '撤回委派', submit: '提交验收'
};
const destructive = computed(() => ['align', 'forceDeleteBranch', 'cancel'].includes(props.request?.operation));
const context = computed(() => {
  const lines = props.request?.detail.split('\n') || [];
  return props.request?.operation === 'align'
    ? lines.filter(line => !/^(原提交将保存在|本次不创建备份分支)/.test(line))
    : lines;
});
watch(() => props.request, request => {
  if (!request) { modal.value?.close(); return; }
  backup.value = request.options?.keepBackup === true;
  modal.value.showModal();
  cancelButton.value.focus();
}, { flush: 'post' });
</script>

<template>
  <dialog ref="modal" class="operation-dialog" aria-labelledby="operation-title" @cancel.prevent="emit('decision', false, false)">
    <template v-if="request">
      <h2 id="operation-title">{{ request.title }}</h2>
      <div class="operation-context">
        <p v-for="(line, index) in context" :key="index" :class="{ 'operation-path': index === 0 }">{{ line }}</p>
      </div>
      <template v-if="request.operation === 'align'">
        <label class="git-align-backup"><input v-model="backup" id="git-keep-align-backup" type="checkbox">保留备份分支</label>
        <p class="hint">{{ backup ? '原提交将保存在新建的本地备份分支。' : '当前分支独有的提交将从这条分支的历史中移除。' }}</p>
      </template>
      <div class="button-line operation-actions">
        <button ref="cancelButton" type="button" @click="emit('decision', false, false)">取消</button>
        <button id="confirm-operation" type="button" :class="destructive ? 'danger-primary' : 'primary'"
          @click="emit('decision', true, backup)">{{ labels[request.operation] || '确认' }}</button>
      </div>
    </template>
  </dialog>
</template>
