package dev.tcw.server;

import java.time.Instant;
import java.sql.Timestamp;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
class TaskService {
    private final JdbcTemplate db;
    private final ProjectService projects;
    TaskService(JdbcTemplate db, ProjectService projects) { this.db=db; this.projects=projects; }

    record Task(String id,String projectId,String title,String description,String status,String assigneeId,
                Instant dueAt,long version,int roundNo,boolean overdue) {}
    record Round(int roundNo,String submittedBy,String summary,String reviewerId,String opinion,String decision,
                 String reason,String decidedBy,Instant submittedAt,Instant decidedAt) {}
    record Activity(long id,String taskId,String actorId,String actorName,String kind,String detail,Instant occurredAt) {}
    record Create(String title,String description,String assigneeId,Instant dueAt) {}
    record Change(long version,String text,String memberId,Instant dueAt) {}

    private void lockProject(String p,String u) {
        // All membership-changing and task writes lock project first, then task.
        db.queryForList("SELECT id FROM projects WHERE id=? FOR UPDATE",p);
        projects.requireMember(p,u);
    }
    private void owner(String p,String u) {
        if (!projects.requireMember(p,u).role().equals("OWNER")) forbidden("仅项目组长可执行此操作。");
    }
    private static void forbidden(String message) { throw new ApiFailure(HttpStatus.FORBIDDEN,"FORBIDDEN",message); }
    private static void conflict() { throw new ApiFailure(HttpStatus.CONFLICT,"TASK_CHANGED","任务状态或版本已变化，请刷新后重试。"); }
    private static String required(String s,int max) {
        if(s==null || s.strip().isEmpty() || s.length()>max) throw ApiFailure.input("请填写有效内容（最多 "+max+" 字）。");
        return s.strip();
    }
    private void validMember(String p,String member) {
        if(member==null) throw ApiFailure.input("请选择成员。");
        if(db.queryForObject("SELECT COUNT(*) FROM project_members WHERE project_id=? AND user_id=?",Integer.class,p,member)!=1)
            throw ApiFailure.input("该成员不在当前项目。");
    }
    private Task read(String id,boolean lock) {
        return db.query("SELECT * FROM tasks WHERE id=?"+(lock?" FOR UPDATE":""),(rs,i)->{
            var due=rs.getTimestamp("due_at");
            String status=rs.getString("status");
            return new Task(rs.getString("id"),rs.getString("project_id"),rs.getString("title"),rs.getString("description"),
                status,rs.getString("assignee_id"),due==null?null:due.toInstant(),rs.getLong("version"),rs.getInt("round_no"),
                due!=null && due.toInstant().isBefore(Instant.now()) && !Set.of("DONE","CANCELED").contains(status));
        },id).stream().findFirst().orElseThrow(ApiFailure::missing);
    }
    private void event(String p,String task,String user,String kind,String detail) {
        db.update("INSERT INTO activities(project_id,task_id,actor_id,kind,detail) VALUES (?,?,?,?,?)",p,task,user,kind,detail);
    }
    @Transactional(readOnly=true)
    List<Task> list(String p,String u) {
        projects.requireMember(p,u);
        return db.queryForList("SELECT id FROM tasks WHERE project_id=? ORDER BY created_at DESC,id LIMIT 500",String.class,p)
            .stream().map(id->read(id,false)).toList();
    }
    @Transactional
    Task create(String p,String u,Create input) {
        lockProject(p,u); owner(p,u);
        String title=required(input.title(),120), desc=input.description()==null?"":input.description();
        if(desc.length()>8000) throw ApiFailure.input("任务说明最多 8000 字。");
        if(input.assigneeId()!=null) validMember(p,input.assigneeId());
        String id=UUID.randomUUID().toString();
        db.update("INSERT INTO tasks(id,project_id,title,description,status,assignee_id,due_at) VALUES (?,?,?,?,?,?,?)",
            id,p,title,desc,input.assigneeId()==null?"OPEN":"ASSIGNED",input.assigneeId(),input.dueAt()==null?null:Timestamp.from(input.dueAt()));
        event(p,id,u,"PUBLISHED",title);
        return read(id,false);
    }
    @Transactional
    Task action(String p,String id,String u,String action,Change input) {
        lockProject(p,u);
        Task t=read(id,true);
        if(!t.projectId().equals(p)) throw ApiFailure.missing();
        if(t.version()!=input.version()) conflict();
        String status=t.status(), assignee=t.assigneeId(); int round=t.roundNo();
        String detail="";
        switch(action) {
            case "claim" -> {
                if(!status.equals("OPEN") || assignee!=null) conflict();
                assignee=u; status="ASSIGNED";
            }
            case "start" -> {
                if(!u.equals(assignee)) forbidden("只有任务负责人可以开始。");
                if(!status.equals("ASSIGNED")) conflict();
                status="IN_PROGRESS";
            }
            case "submit" -> {
                if(!u.equals(assignee)) forbidden("只有任务负责人可以提交验收。");
                if(!status.equals("IN_PROGRESS")) conflict();
                detail=required(input.text(),8000); round++;
                db.update("INSERT INTO task_rounds(task_id,round_no,submitted_by,summary) VALUES (?,?,?,?)",id,round,u,detail);
                status="IN_REVIEW";
            }
            case "delegate" -> {
                owner(p,u); if(!status.equals("IN_REVIEW")) conflict();
                validMember(p,input.memberId());
                if(input.memberId().equals(u)) throw ApiFailure.input("不能委派组长自己复核，请选择其他组员。");
                if(input.memberId().equals(assignee)) throw ApiFailure.input("不能委派负责人复核自己的成果。");
                int delegated=db.update("UPDATE task_rounds SET reviewer_id=? WHERE task_id=? AND round_no=? AND decision='PENDING' AND reviewer_id IS NULL AND opinion IS NULL",
                    input.memberId(),id,round);
                if(delegated!=1) throw ApiFailure.input("本轮已有复核委派。需要更换时，请在意见提交前先撤回。");
                detail="委派复核："+input.memberId();
            }
            case "revoke-review" -> {
                owner(p,u); if(!status.equals("IN_REVIEW")) conflict();
                int revoked=db.update("UPDATE task_rounds SET reviewer_id=NULL WHERE task_id=? AND round_no=? AND decision='PENDING' AND reviewer_id IS NOT NULL AND opinion IS NULL",
                    id,round);
                if(revoked!=1) throw ApiFailure.input("只有仍在等待意见的复核委派可以撤回。");
                detail="撤回复核委派";
            }
            case "review" -> {
                if(!status.equals("IN_REVIEW")) conflict();
                var reviewer=db.queryForObject("SELECT reviewer_id FROM task_rounds WHERE task_id=? AND round_no=?",String.class,id,round);
                if(!u.equals(reviewer)) forbidden("仅本轮受委派的成员可写复核意见。");
                if(u.equals(assignee) || projects.requireMember(p,u).role().equals("OWNER"))
                    forbidden("复核意见须由受委派的其他组员提交。");
                if(db.queryForObject("SELECT COUNT(*) FROM task_rounds WHERE task_id=? AND round_no=? AND opinion IS NOT NULL",Integer.class,id,round)>0)
                    throw ApiFailure.input("本轮意见已提交，不能覆盖历史。");
                detail=required(input.text(),8000);
                db.update("UPDATE task_rounds SET opinion=? WHERE task_id=? AND round_no=?",detail,id,round);
            }
            case "accept", "return" -> {
                owner(p,u); if(!status.equals("IN_REVIEW")) conflict();
                detail=action.equals("return")?required(input.text(),2000):"验收通过";
                int decided=db.update("UPDATE task_rounds SET decision=?,reason=?,decided_by=?,decided_at=CURRENT_TIMESTAMP(6) WHERE task_id=? AND round_no=? AND decision='PENDING' AND (reviewer_id IS NULL OR opinion IS NOT NULL)",
                    action.equals("accept")?"ACCEPTED":"RETURNED",detail,u,id,round);
                if(decided!=1) throw ApiFailure.input("本轮仍在等待复核意见。请等待组员提交，或先撤回复核委派。");
                status=action.equals("accept")?"DONE":"IN_PROGRESS";
            }
            case "assign" -> {
                owner(p,u);
                if(!Set.of("OPEN","ASSIGNED","IN_PROGRESS").contains(status)) conflict();
                detail=required(input.text(),2000); validMember(p,input.memberId());
                assignee=input.memberId(); status="ASSIGNED";
            }
            case "deadline" -> {
                owner(p,u); if(Set.of("DONE","CANCELED").contains(status)) conflict();
                detail=required(input.text(),2000);
                db.update("UPDATE tasks SET due_at=? WHERE id=?",input.dueAt()==null?null:Timestamp.from(input.dueAt()),id);
            }
            case "cancel" -> {
                owner(p,u); if(Set.of("DONE","CANCELED").contains(status)) conflict();
                detail=required(input.text(),2000);
                if(status.equals("IN_REVIEW")) db.update("UPDATE task_rounds SET decision='CANCELED',reason=?,decided_by=?,decided_at=CURRENT_TIMESTAMP(6) WHERE task_id=? AND round_no=? AND decision='PENDING'",detail,u,id,round);
                status="CANCELED";
            }
            default -> throw ApiFailure.input("不支持该任务操作。");
        }
        int updated=db.update("UPDATE tasks SET status=?,assignee_id=?,round_no=?,version=version+1 WHERE id=? AND version=?",
            status,assignee,round,id,t.version());
        if(updated!=1) conflict();
        event(p,id,u,action.toUpperCase(Locale.ROOT).replace('-','_'),detail.isBlank()?t.title():detail);
        return read(id,false);
    }
    @Transactional(readOnly=true)
    List<Round> rounds(String p,String id,String u) {
        projects.requireMember(p,u);
        if(!read(id,false).projectId().equals(p)) throw ApiFailure.missing();
        return db.query("SELECT * FROM task_rounds WHERE task_id=? ORDER BY round_no DESC",(rs,i)->{
            var decided=rs.getTimestamp("decided_at");
            return new Round(rs.getInt("round_no"),rs.getString("submitted_by"),rs.getString("summary"),rs.getString("reviewer_id"),
                rs.getString("opinion"),rs.getString("decision"),rs.getString("reason"),rs.getString("decided_by"),
                rs.getTimestamp("submitted_at").toInstant(),decided==null?null:decided.toInstant());
        },id);
    }
    @Transactional(readOnly=true)
    List<Activity> activities(String p,String u,long before) {
        projects.requireMember(p,u);
        return db.query("SELECT a.*,u.display_name FROM activities a JOIN app_users u ON a.actor_id=u.id WHERE project_id=? AND a.id<? ORDER BY a.id DESC LIMIT 100",
            (rs,i)->new Activity(rs.getLong("id"),rs.getString("task_id"),rs.getString("actor_id"),rs.getString("display_name"),
                rs.getString("kind"),rs.getString("detail"),rs.getTimestamp("occurred_at").toInstant()),p,before);
    }
    @Transactional
    void remove(String p,String member,String u,String reason) {
        lockProject(p,u); owner(p,u); validMember(p,member);
        if(projects.requireMember(p,member).role().equals("OWNER")) throw ApiFailure.input("不能移除项目组长。");
        required(reason,2000);
        if(db.queryForObject("SELECT COUNT(*) FROM tasks WHERE project_id=? AND assignee_id=? AND status NOT IN ('DONE','CANCELED')",Integer.class,p,member)>0)
            throw ApiFailure.input("请先转交或取消该成员的未完成任务。");
        db.update("UPDATE task_rounds r JOIN tasks t ON t.id=r.task_id SET r.reviewer_id=NULL WHERE t.project_id=? AND r.reviewer_id=? AND r.decision='PENDING' AND r.opinion IS NULL",p,member);
        db.update("DELETE FROM project_members WHERE project_id=? AND user_id=?",p,member);
        event(p,null,u,"MEMBER_REMOVED",member+"："+reason);
    }
}
