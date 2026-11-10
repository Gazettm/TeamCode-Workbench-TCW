package dev.tcw.server;

import org.springframework.http.HttpStatus;

final class ApiFailure extends RuntimeException {
    final HttpStatus status;
    final String code;

    ApiFailure(HttpStatus status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    static ApiFailure input(String message) {
        return new ApiFailure(HttpStatus.BAD_REQUEST, "INVALID_INPUT", message);
    }

    static ApiFailure session() {
        return new ApiFailure(HttpStatus.UNAUTHORIZED, "SESSION_EXPIRED", "请重新登录协作服务。");
    }

    static ApiFailure missing() {
        return new ApiFailure(HttpStatus.NOT_FOUND, "NOT_FOUND", "项目或邀请不存在，或你无权访问。");
    }
}
