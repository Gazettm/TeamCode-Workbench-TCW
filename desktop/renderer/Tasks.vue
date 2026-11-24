<script setup>
import { ref, computed, onMounted, watch } from 'vue';
const props=defineProps({project:Object,user:Object,members:Array,api:Function,scope:String,workspace:Object,branches:Object,bindGit:Function,view:String});
const emit=defineEmits(['pending','expired']);
const tasks=ref([]), activities=ref([]), selected=ref(null), rounds=ref([]);
const busy=ref(false), error=ref(''), message=ref('');
const title=ref(''), description=ref(''), assignee=ref(''), due=ref('');
const text=ref(''), member=ref(''), revisedDue=ref('');
const filter=ref('all'), showCreate=ref(false);
const owner=computed(()=>props.project.role==='OWNER');
const labels={OPEN:'待领取',ASSIGNED:'已指派',IN_PROGRESS:'进行中',IN_REVIEW:'待验收',DONE:'已完成',CANCELED:'已取消'};
const visibleTasks=computed(()=>filter.value==='all' ? tasks.value : tasks.value.filter(task=>task.status===filter.value));
const events={PUBLISHED:'发布',CLAIM:'领取',START:'开始',SUBMIT:'提交验收',DELEGATE:'委派复核',REVOKE_REVIEW:'撤回复核',REVIEW:'复核意见',ACCEPT:'验收通过',RETURN:'退回',ASSIGN:'调整负责人',DEADLINE:'调整截止',CANCEL:'取消',MEMBER_REMOVED:'移除成员'};
const confirmations={accept:'验收通过',return:'退回',assign:'重新指派',deadline:'调整截止',cancel:'取消任务',delegate:'委派复核','revoke-review':'撤回复核委派'};
const name=id=>props.members.find(m=>m.id===id)?.displayName || (id?'历史成员':'未指派');
const format=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'无截止时间';
const mine=computed(()=>selected.value?.assigneeId===props.user.id);
const pendingRound=computed(()=>selected.value?.status==='IN_REVIEW' && rounds.value[0]?.roundNo===selected.value.roundNo ? rounds.value[0] : null);
const reviewerOptions=computed(()=>props.members.filter(m=>m.id!==props.user.id && m.id!==selected.value?.assigneeId));
const waitingForOpinion=computed(()=>Boolean(pendingRound.value?.reviewerId && !pendingRound.value.opinion));
const canReview=computed(()=>!owner.value && !mine.value && pendingRound.value?.reviewerId===props.user.id && !pendingRound.value.opinion);
const terminal=computed(()=>['DONE','CANCELED'].includes(selected.value?.status));
const gitInfo=ref(null), gitBranch=ref('');
const taskBranch=computed(()=>props.branches?.[selected.value?.id]);
const localGit=(op,input={})=>props.api('git',props.scope,props.workspace.id,op,input);
const call=(op,data={})=>props.api('collaborate',op,{projectId:props.project.id,...data});
async function checkGit() {
 gitInfo.value=null;
 if(!props.workspace) return;
 const workspaceId=props.workspace.id;
 const result=await localGit('read').catch(()=>null);
 if (props.workspace?.id===workspaceId) gitInfo.value=result;
}
function gitWarning() {
 const info=gitInfo.value;
 if(!props.workspace || !taskBranch.value) return '尚未关联任务分支，无法确认 Git 状态。';
 if(!info || info.branch!==taskBranch.value) return '当前工作区未检出任务分支，无法确认 Git 状态。';
 const hints=[];
 if(info.dirty) hints.push('仓库有未提交改动。');
 if(info.ahead>0) hints.push('分支有尚未推送的提交（基于最近获取的状态）。');
 if(!info.upstream || info.ahead===null) hints.push('无法确认推送状态。');
 return hints.join(' ');
}
const branchOperation=kind=>run(async()=>{
 const taskId=selected.value.id;
 const workspaceId=props.workspace.id;
 if(kind==='bind') {
  await props.bindGit(props.project.id,workspaceId,taskId,gitBranch.value);
 } else {
  const info=await localGit('read');
  const target=kind==='createBranch' ? 'task/'+taskId : taskBranch.value;
  const operation=info.branches.includes(target) ? 'switch' : kind;
  const result=await localGit(operation,{branch:info.branch,head:info.head,target});
  if(result.canceled)return;
  if(kind==='createBranch')await props.bindGit(props.project.id,workspaceId,taskId,target);
 }
 await checkGit();
 message.value='任务分支已更新。';
});
async function load() {
 tasks.value=await call('tasks');
 if(selected.value) {
  selected.value=tasks.value.find(t=>t.id===selected.value.id)||null;
  rounds.value=selected.value?await call('rounds',{taskId:selected.value.id}):[];
 }
 activities.value=await call('activities');
 if(selected.value)await checkGit();
}
async function run(action) {
 if(busy.value)return;
 busy.value=true;emit('pending',true);error.value='';message.value='';
 try{await action();}
 catch(e){error.value=e.message;if(e.code==='SESSION_EXPIRED')emit('expired');}
 finally{busy.value=false;emit('pending',false);}
}
const choose=t=>run(async()=>{
 const taskRounds=await call('rounds',{taskId:t.id});
 selected.value=t;rounds.value=taskRounds;text.value='';member.value='';revisedDue.value='';gitBranch.value='';
 await checkGit();
});
const create=()=>run(async()=>{
 const result=await call('createTask',{title:title.value,description:description.value,assigneeId:assignee.value||null,dueAt:due.value?new Date(due.value).toISOString():null});
 title.value='';description.value='';due.value='';selected.value=result;showCreate.value=false;filter.value='all';
 await load();message.value='任务已发布。';
});
async function action(kind) {
 if(confirmations[kind] && !window.confirm('确认执行“'+confirmations[kind]+'”？'))return;
 await run(async()=>{
  if(kind==='submit'){
   await checkGit();
   const warning=gitWarning();
   if(warning && !window.confirm(warning+' 继续提交验收吗？'))return;
  }
  try{
   selected.value=await call('taskAction',{taskId:selected.value.id,version:selected.value.version,action:kind,text:text.value,memberId:member.value||null,dueAt:revisedDue.value?new Date(revisedDue.value).toISOString():null});
  }catch(e){await load().catch(()=>{});throw e;}
  if(kind==='delegate' || kind==='revoke-review')member.value='';
  text.value='';await load();message.value='操作已保存。';
 });
}
onMounted(()=>run(load));
watch(()=>props.workspace?.id,()=>{gitBranch.value='';checkGit();});
</script>

<template>
<section class="task-area">
 <div class="task-heading section-bar">
  <h2>{{ view === 'activity' ? '项目动态' : '任务看板' }}</h2>
  <div class="button-line"><button :disabled="busy" @click="run(load)">刷新任务与动态</button>
   <button v-if="owner && view === 'tasks'" id="show-create-task" class="primary" :aria-expanded="showCreate" :disabled="busy" @click="showCreate = !showCreate">{{ showCreate ? '收起发布表单' : '新建任务' }}</button></div>
 </div>
 <div v-if="error" class="notice error" role="alert">{{error}}</div><div v-if="message" class="notice success" role="status">{{message}}</div>
 <template v-if="view === 'tasks'">
 <form v-if="owner && showCreate" class="panel collab-form task-create" @submit.prevent="create">
  <h3>发布任务</h3><label for="task-title">标题</label><input id="task-title" v-model="title" required maxlength="120">
  <label for="task-description">说明</label><textarea id="task-description" v-model="description" maxlength="8000"></textarea>
  <div class="task-fields"><label>负责人<select v-model="assignee"><option value="">开放领取</option><option v-for="m in members" :key="m.id" :value="m.id">{{m.displayName}}</option></select></label>
  <label>截止时间（本机时区，可选）<input v-model="due" type="datetime-local"></label></div>
  <button type="submit" class="primary" :disabled="busy">发布任务</button>
 </form>
 <div class="task-layout">
 <section class="panel task-list">
  <div class="task-heading"><h3>任务列表</h3><span class="pill">{{visibleTasks.length}} 项</span></div>
  <label for="task-status-filter">按状态查看</label>
  <select id="task-status-filter" v-model="filter" :disabled="busy"><option value="all">全部状态</option><option v-for="(label,status) in labels" :key="status" :value="status">{{label}}</option></select>
  <div class="task-choices">
   <button v-for="task in visibleTasks" :key="task.id" :class="['task-card',{chosen:selected?.id===task.id}]" :aria-pressed="selected?.id===task.id" :disabled="busy" @click="choose(task)">
    <span class="task-card-heading"><strong>{{task.title}}</strong><span :class="['badge', 'task-state-'+task.status]">{{labels[task.status]}}</span></span>
    <span class="task-card-meta">{{name(task.assigneeId)}} <small v-if="task.overdue" class="overdue">已逾期</small><small v-else-if="task.dueAt">{{format(task.dueAt)}}</small></span>
   </button>
   <p v-if="!visibleTasks.length" class="muted">{{filter === 'all' ? '暂无任务' : '没有符合此状态的任务'}}</p>
  </div>
  <p v-if="tasks.length === 500" class="hint">仅显示最近 500 个任务。</p>
 </section>
 <section v-if="selected" class="panel task-detail">
  <div class="task-heading"><h2>{{selected.title}}</h2><span :class="['badge', 'task-state-'+selected.status]">{{labels[selected.status]}}</span></div>
  <p class="task-description">{{selected.description||'暂无说明'}}</p><p>负责人：{{name(selected.assigneeId)}} · {{format(selected.dueAt)}} <span v-if="selected.overdue" class="overdue">已逾期</span></p>
  <div class="button-line">
   <button v-if="selected.status==='OPEN'" class="primary" :disabled="busy" @click="action('claim')">领取任务</button>
   <button v-if="mine && selected.status==='ASSIGNED'" class="primary" :disabled="busy" @click="action('start')">开始工作</button>
  </div>
  <div v-if="!terminal" class="collab-form">
   <section v-if="mine && ['ASSIGNED','IN_PROGRESS'].includes(selected.status)" class="task-git">
    <h3>任务分支</h3>
    <p v-if="!workspace" class="hint">在「成员与仓库」选择工作区后，可关联任务分支。</p>
    <template v-else>
     <p class="hint">{{ workspace.name }} · {{ taskBranch || '尚未关联分支' }}<span v-if="gitInfo?.branch"> · 当前 {{ gitInfo.branch }}</span></p>
     <div v-if="gitInfo" class="git-controls">
      <label>关联已有分支 <select v-model="gitBranch" :disabled="busy"><option value="">选择分支</option><option v-for="name in gitInfo.branches" :key="name">{{ name }}</option></select></label>
      <button :disabled="busy || !gitBranch || gitBranch===taskBranch" @click="branchOperation('bind')">关联分支</button>
      <button v-if="!taskBranch" :disabled="busy || gitInfo.dirty || !gitInfo.head" @click="branchOperation('createBranch')">从当前提交创建任务分支</button>
      <button v-else :disabled="busy || gitInfo.dirty || gitInfo.branch===taskBranch || !gitInfo.branches.includes(taskBranch)" @click="branchOperation('switch')">切换到任务分支</button>
     </div>
    </template>
    <p v-if="selected.status==='IN_PROGRESS' && gitWarning()" class="hint">{{ gitWarning() }}</p>
   </section>
   <template v-if="owner || canReview || (mine && selected.status==='IN_PROGRESS')">
    <label for="task-operation-text">{{ canReview ? '复核意见' : mine && selected.status==='IN_PROGRESS' ? '成果说明或调整原因' : '任务调整或退回原因' }}</label>
    <textarea id="task-operation-text" v-model="text" maxlength="8000"></textarea>
   </template>
   <div class="button-line">
    <button v-if="mine && selected.status==='IN_PROGRESS'" class="primary" :disabled="busy||!text.trim()" @click="action('submit')">提交验收</button>
    <button v-if="canReview" :disabled="busy||!text.trim()" @click="action('review')">保存复核意见</button>
    <template v-if="owner && selected.status==='IN_REVIEW'"><button class="primary" :disabled="busy||!pendingRound||waitingForOpinion" @click="action('accept')">验收通过</button><button :disabled="busy||!pendingRound||waitingForOpinion||!text.trim()" @click="action('return')">退回</button></template>
   </div>
   <template v-if="owner">
    <template v-if="pendingRound">
     <template v-if="pendingRound.reviewerId || pendingRound.opinion">
      <p class="hint">{{pendingRound.opinion ? '复核意见已提交，可在验收历史查看。' : '已委派给 '+name(pendingRound.reviewerId)+'。组员提交意见或组长撤回委派后，才可验收通过或退回。'}}</p>
      <div v-if="pendingRound.reviewerId && !pendingRound.opinion" class="button-line"><button :disabled="busy" @click="action('revoke-review')">撤回复核委派</button></div>
     </template>
     <template v-else-if="reviewerOptions.length">
      <label>选择复核组员<select v-model="member" :disabled="busy"><option value="">请选择</option><option v-for="m in reviewerOptions" :key="m.id" :value="m.id">{{m.displayName}}</option></select></label>
      <div class="button-line"><button :disabled="busy||!reviewerOptions.some(m=>m.id===member)" @click="action('delegate')">委派复核</button></div>
     </template>
     <p v-else class="hint">当前项目没有可复核的其他组员，组长可直接验收。</p>
    </template>
    <template v-else-if="selected.status!=='IN_REVIEW'">
     <label>选择成员<select v-model="member"><option value="">请选择</option><option v-for="m in members" :key="m.id" :value="m.id">{{m.displayName}}</option></select></label>
     <div class="button-line"><button :disabled="busy||!member||!text.trim()" @click="action('assign')">调整负责人</button></div>
    </template>
    <label>新的截止时间（留空清除）<input v-model="revisedDue" type="datetime-local"></label>
    <div class="button-line"><button :disabled="busy||!text.trim()" @click="action('deadline')">调整截止</button><button :disabled="busy||!text.trim()" @click="action('cancel')">取消任务</button></div>
   </template>
  </div>
  <h3>验收历史</h3><article v-for="round in rounds" :key="round.roundNo" class="review-round">
   <strong>第 {{round.roundNo}} 轮 · {{({PENDING:'待验收',ACCEPTED:'已通过',RETURNED:'已退回',CANCELED:'已取消'})[round.decision]}}</strong>
   <p class="task-description">{{round.summary}}</p><p>提交人：{{name(round.submittedBy)}} · {{format(round.submittedAt)}}</p>
   <p v-if="round.reviewerId">复核者：{{name(round.reviewerId)}}；意见：{{round.opinion||'尚未提交'}}</p>
   <p v-if="round.reason">结论：{{round.reason}} · {{name(round.decidedBy)}}</p>
  </article><p v-if="!rounds.length">尚未提交验收。</p>
 </section>
 <section v-else class="panel empty task-empty"><h2>选择一个任务</h2><p>查看说明、任务分支和验收记录。</p></section>
 </div>
 </template>
 <section v-else-if="view === 'activity'" class="panel activity-list" aria-label="项目动态">
  <article v-for="a in activities" :key="a.id"><strong>{{a.actorName}} · {{events[a.kind]||a.kind}}</strong><p class="task-description">{{a.detail}}</p><small>{{format(a.occurredAt)}}</small></article>
  <p v-if="!activities.length">暂无任务动态。</p>
  <button v-if="activities.length>=100" :disabled="busy" @click="run(async()=>{const older=await call('activities',{before:activities[activities.length-1].id});activities.push(...older)})">加载更早动态</button>
 </section>
</section>
</template>

