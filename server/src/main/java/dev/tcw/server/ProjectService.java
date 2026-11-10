package dev.tcw.server;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;

import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
class ProjectService {
    record Project(String id, String name, String role) {}
    record Member(String id, String username, String displayName, String role) {}
    record Invitation(String id, Instant createdAt, Instant expiresAt, Instant revokedAt) {}
    record IssuedInvitation(String id, Instant expiresAt, String code) {}
    private record InviteTarget(String projectId, Instant expiresAt, boolean revoked) {}

    private final JdbcTemplate jdbc;

    ProjectService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    List<Project> list(String userId) {
        return jdbc.query("""
            SELECT p.id, p.name, m.role FROM project_members m JOIN projects p ON p.id=m.project_id
            WHERE m.user_id=? ORDER BY p.created_at DESC, p.id
            """, (rs, i) -> new Project(rs.getString(1), rs.getString(2), rs.getString(3)), userId);
    }

    @Transactional
    Project create(String userId, String name) {
        var clean = name.strip();
        if (clean.isBlank() || clean.codePoints().anyMatch(Character::isISOControl)) throw ApiFailure.input("请输入有效项目名称。");
        var id = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO projects(id, name) VALUES (?, ?)", id, clean);
        jdbc.update("INSERT INTO project_members(project_id, user_id, role) VALUES (?, ?, 'OWNER')", id, userId);
        return new Project(id, clean, "OWNER");
    }

    Project requireMember(String projectId, String userId) {
        return jdbc.query("""
            SELECT p.id, p.name, m.role FROM projects p JOIN project_members m ON m.project_id=p.id
            WHERE p.id=? AND m.user_id=?
            """, (rs, i) -> new Project(rs.getString(1), rs.getString(2), rs.getString(3)),
            projectId, userId).stream().findFirst().orElseThrow(ApiFailure::missing);
    }

    @Transactional(readOnly = true)
    List<Member> members(String projectId, String userId) {
        requireMember(projectId, userId);
        return jdbc.query("""
            SELECT u.id, u.username, u.display_name, m.role
            FROM project_members m JOIN app_users u ON u.id=m.user_id WHERE m.project_id=?
            ORDER BY m.role, m.joined_at, u.username
            """, (rs, i) -> new Member(rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4)), projectId);
    }

    private void requireOwner(String projectId, String userId) {
        if (!requireMember(projectId, userId).role().equals("OWNER")) {
            throw new ApiFailure(HttpStatus.FORBIDDEN, "OWNER_REQUIRED", "仅项目组长可管理邀请。");
        }
    }

    @Transactional(readOnly = true)
    List<Invitation> invitations(String projectId, String userId) {
        requireOwner(projectId, userId);
        return jdbc.query("""
            SELECT id, created_at, expires_at, revoked_at FROM project_invitations
            WHERE project_id=? ORDER BY created_at DESC, id
            """, (rs, i) -> {
                var revoked = rs.getTimestamp(4);
                return new Invitation(rs.getString(1), rs.getTimestamp(2).toInstant(), rs.getTimestamp(3).toInstant(),
                    revoked == null ? null : revoked.toInstant());
            }, projectId);
    }

    @Transactional
    IssuedInvitation issue(String projectId, String userId, int hours) {
        requireOwner(projectId, userId);
        var id = UUID.randomUUID().toString();
        var code = Secrets.random(18);
        var expiresAt = Instant.now().plus(hours, ChronoUnit.HOURS);
        jdbc.update("INSERT INTO project_invitations(id, project_id, code_hash, expires_at) VALUES (?, ?, ?, ?)",
            id, projectId, Secrets.digest(code), Timestamp.from(expiresAt));
        return new IssuedInvitation(id, expiresAt, code);
    }

    @Transactional
    void revoke(String projectId, String invitationId, String userId) {
        requireOwner(projectId, userId);
        int updated = jdbc.update("""
            UPDATE project_invitations SET revoked_at=COALESCE(revoked_at, ?)
            WHERE id=? AND project_id=?
            """, Timestamp.from(Instant.now()), invitationId, projectId);
        if (updated == 0 && !Boolean.TRUE.equals(jdbc.queryForObject(
            "SELECT EXISTS(SELECT 1 FROM project_invitations WHERE id=? AND project_id=?)",
            Boolean.class, invitationId, projectId))) throw ApiFailure.missing();
    }

    @Transactional
    Project join(String userId, String code) {
        var target = jdbc.query("""
            SELECT project_id, expires_at, revoked_at FROM project_invitations WHERE code_hash=? FOR UPDATE
            """, (rs, i) -> new InviteTarget(rs.getString(1), rs.getTimestamp(2).toInstant(), rs.getTimestamp(3) != null),
            Secrets.digest(code)).stream().findFirst().orElse(null);
        if (target == null || target.revoked() || !target.expiresAt().isAfter(Instant.now())) {
            throw new ApiFailure(HttpStatus.BAD_REQUEST, "INVITATION_INVALID", "邀请码无效、已过期或已撤销。");
        }
        jdbc.update("""
            INSERT INTO project_members(project_id, user_id, role) VALUES (?, ?, 'MEMBER')
            ON DUPLICATE KEY UPDATE joined_at=joined_at
            """, target.projectId(), userId);
        return requireMember(target.projectId(), userId);
    }
}
