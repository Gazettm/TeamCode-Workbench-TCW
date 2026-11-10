package dev.tcw.server;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Locale;
import java.util.UUID;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

@Service
class AuthService {
    record User(String id, String username, String displayName) {}
    record Session(String token, Instant expiresAt, User user) {}
    record Principal(String tokenHash, User user) {}
    private record Credentials(User user, String passwordHash) {}

    private final JdbcTemplate jdbc;
    private final BCryptPasswordEncoder passwords = new BCryptPasswordEncoder(10);
    private final String placeholderHash = passwords.encode(Secrets.random(24));

    AuthService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

    User register(String username, String displayName, String password) {
        if (!username.matches("[A-Za-z0-9_.-]{3,32}")) {
            throw ApiFailure.input("账号名须为 3–32 位英文、数字、点、下划线或短横线。");
        }
        if (password.length() < 8 || password.getBytes(StandardCharsets.UTF_8).length > 72 || password.indexOf('\0') >= 0) {
            throw ApiFailure.input("密码至少 8 个字符，且 UTF-8 编码后最多 72 字节。");
        }
        var user = new User(UUID.randomUUID().toString(), normalize(username), displayName.strip());
        if (user.displayName().isBlank() || user.displayName().codePoints().anyMatch(Character::isISOControl)) {
            throw ApiFailure.input("请输入有效显示名。");
        }
        try {
            jdbc.update("INSERT INTO app_users(id, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
                user.id(), user.username(), user.displayName(), passwords.encode(password));
        } catch (DuplicateKeyException error) {
            throw new ApiFailure(HttpStatus.CONFLICT, "USERNAME_TAKEN", "此账号名已注册。");
        }
        return user;
    }

    Session login(String username, String password) {
        if (password.getBytes(StandardCharsets.UTF_8).length > 72 || password.indexOf('\0') >= 0) {
            throw invalidCredentials();
        }
        var account = jdbc.query("SELECT id, username, display_name, password_hash FROM app_users WHERE username = ?",
            (rs, row) -> new Credentials(new User(rs.getString(1), rs.getString(2), rs.getString(3)), rs.getString(4)),
            normalize(username)).stream().findFirst().orElse(null);
        boolean matches = passwords.matches(password, account == null ? placeholderHash : account.passwordHash());
        if (!matches || account == null) throw invalidCredentials();
        var now = Instant.now();
        var token = Secrets.random(32);
        var expires = now.plus(12, ChronoUnit.HOURS);
        jdbc.update("DELETE FROM auth_sessions WHERE expires_at <= ?", Timestamp.from(now));
        jdbc.update("INSERT INTO auth_sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            Secrets.digest(token), account.user().id(), Timestamp.from(expires));
        return new Session(token, expires, account.user());
    }

    Principal require(String authorization) {
        if (authorization == null || !authorization.matches("Bearer [A-Za-z0-9_-]{43}")) throw ApiFailure.session();
        var digest = Secrets.digest(authorization.substring(7));
        var user = jdbc.query("""
            SELECT u.id, u.username, u.display_name
            FROM auth_sessions s JOIN app_users u ON s.user_id = u.id
            WHERE s.token_hash = ? AND s.expires_at > ?
            """, (rs, row) -> new User(rs.getString(1), rs.getString(2), rs.getString(3)),
            digest, Timestamp.from(Instant.now())).stream().findFirst().orElseThrow(ApiFailure::session);
        return new Principal(digest, user);
    }

    void logout(Principal principal) {
        jdbc.update("DELETE FROM auth_sessions WHERE token_hash = ?", principal.tokenHash());
    }

    private static String normalize(String username) { return username.strip().toLowerCase(Locale.ROOT); }

    private static ApiFailure invalidCredentials() {
        return new ApiFailure(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "账号或密码不正确。");
    }
}
