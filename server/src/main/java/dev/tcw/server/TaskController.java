package dev.tcw.server;

import java.time.Instant;
import java.util.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpStatus;

@RestController
@RequestMapping("/api/projects/{projectId}")
class TaskController {
    private final TaskService tasks;
    TaskController(TaskService tasks) { this.tasks=tasks; }
    record NewTask(@NotBlank @Size(max=120) String title,@Size(max=8000) String description,UUID assigneeId,Instant dueAt) {}
    record Action(@NotNull @Min(0) Long version,@Size(max=8000) String text,UUID memberId,Instant dueAt) {}
    record Removal(@NotBlank @Size(max=2000) String reason) {}
    @GetMapping("/tasks")
    List<TaskService.Task> list(@PathVariable UUID projectId,@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal who) {
        return tasks.list(projectId.toString(),who.user().id());
    }
    @PostMapping("/tasks") @ResponseStatus(HttpStatus.CREATED)
    TaskService.Task create(@PathVariable UUID projectId,@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal who,@Valid @RequestBody NewTask body) {
        return tasks.create(projectId.toString(),who.user().id(),new TaskService.Create(body.title(),body.description(),body.assigneeId()==null?null:body.assigneeId().toString(),body.dueAt()));
    }
    @PostMapping("/tasks/{taskId}/{action}")
    TaskService.Task action(@PathVariable UUID projectId,@PathVariable UUID taskId,@PathVariable String action,
            @RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal who,@Valid @RequestBody Action body) {
        return tasks.action(projectId.toString(),taskId.toString(),who.user().id(),action,
            new TaskService.Change(body.version(),body.text(),body.memberId()==null?null:body.memberId().toString(),body.dueAt()));
    }
    @GetMapping("/tasks/{taskId}/rounds")
    List<TaskService.Round> rounds(@PathVariable UUID projectId,@PathVariable UUID taskId,@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal who) {
        return tasks.rounds(projectId.toString(),taskId.toString(),who.user().id());
    }
    @GetMapping("/activities")
    List<TaskService.Activity> activities(@PathVariable UUID projectId,@RequestParam(defaultValue="9223372036854775807") long before,
            @RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal who) {
        return tasks.activities(projectId.toString(),who.user().id(),before);
    }
    @PostMapping("/members/{memberId}/remove") @ResponseStatus(HttpStatus.NO_CONTENT)
    void remove(@PathVariable UUID projectId,@PathVariable UUID memberId,@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal who,@Valid @RequestBody Removal body) {
        tasks.remove(projectId.toString(),memberId.toString(),who.user().id(),body.reason());
    }
}
