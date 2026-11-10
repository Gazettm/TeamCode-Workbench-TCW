package dev.tcw.server;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
class ApiController {
    private final AuthService auth;
    private final ProjectService projects;
    private final JdbcTemplate jdbc;

    ApiController(AuthService auth, ProjectService projects, JdbcTemplate jdbc) {
        this.auth = auth;
        this.projects = projects;
        this.jdbc = jdbc;
    }

    record Registration(
        @NotBlank @Size(max=32, message="账号名最多 32 个字符。") String username,
        @NotBlank(message="请输入显示名。") @Size(max=48, message="显示名最多 48 个字符。") String displayName,
        @NotBlank(message="请输入密码。") @Size(min=8, max=72, message="密码须为 8–72 个字符。") String password) {}
    record Login(
        @NotBlank(message="请输入账号。") @Size(max=32) String username,
        @NotBlank(message="请输入密码。") @Size(max=72) String password) {}
    record NewProject(@NotBlank(message="请输入项目名称。") @Size(max=80, message="项目名称最多 80 个字符。") String name) {}
    record NewInvitation(@NotNull @Min(value=1,message="邀请至少有效 1 小时。") @Max(value=168,message="邀请最长有效 168 小时。") Integer validHours) {}
    record Join(@NotBlank @Pattern(regexp="[A-Za-z0-9_-]{24}", message="邀请码应为 24 位字符。") String code) {}

    @GetMapping("/health")
    Map<String, String> health() {
        jdbc.queryForObject("SELECT 1", Integer.class);
        return Map.of("service", "tcw-server", "version", "0.2.0", "status", "ready");
    }

    @PostMapping("/auth/register")
    @ResponseStatus(HttpStatus.CREATED)
    Map<String, AuthService.User> register(@Valid @RequestBody Registration input) {
        return Map.of("user", auth.register(input.username(), input.displayName(), input.password()));
    }

    @PostMapping("/auth/login")
    AuthService.Session login(@Valid @RequestBody Login input) { return auth.login(input.username(), input.password()); }

    @PostMapping("/auth/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void logout(@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal principal) { auth.logout(principal); }

    @GetMapping("/me")
    AuthService.User me(@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal principal) { return principal.user(); }

    @GetMapping("/projects")
    List<ProjectService.Project> projects(@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal principal) {
        return projects.list(principal.user().id());
    }

    @PostMapping("/projects")
    @ResponseStatus(HttpStatus.CREATED)
    ProjectService.Project create(@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal principal, @Valid @RequestBody NewProject input) {
        return projects.create(principal.user().id(), input.name());
    }

    @GetMapping("/projects/{id}")
    ProjectService.Project detail(@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal principal, @PathVariable UUID id) {
        return projects.requireMember(id.toString(), principal.user().id());
    }

    @GetMapping("/projects/{id}/members")
    List<ProjectService.Member> members(@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal principal, @PathVariable UUID id) {
        return projects.members(id.toString(), principal.user().id());
    }

    @GetMapping("/projects/{id}/invitations")
    List<ProjectService.Invitation> invitations(@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal principal, @PathVariable UUID id) {
        return projects.invitations(id.toString(), principal.user().id());
    }

    @PostMapping("/projects/{id}/invitations")
    @ResponseStatus(HttpStatus.CREATED)
    ProjectService.IssuedInvitation invite(@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal principal, @PathVariable UUID id, @Valid @RequestBody NewInvitation input) {
        return projects.issue(id.toString(), principal.user().id(), input.validHours());
    }

    @DeleteMapping("/projects/{id}/invitations/{invitationId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void revoke(@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal principal, @PathVariable UUID id, @PathVariable UUID invitationId) {
        projects.revoke(id.toString(), invitationId.toString(), principal.user().id());
    }

    @PostMapping("/invitations/join")
    ProjectService.Project join(@RequestAttribute(AccessConfig.PRINCIPAL) AuthService.Principal principal, @Valid @RequestBody Join input) {
        return projects.join(principal.user().id(), input.code());
    }
}
