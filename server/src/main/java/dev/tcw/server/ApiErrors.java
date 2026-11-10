package dev.tcw.server;

import java.util.Map;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

@RestControllerAdvice
class ApiErrors {
    @ExceptionHandler(ApiFailure.class)
    ResponseEntity<Map<String, String>> business(ApiFailure error) {
        return ResponseEntity.status(error.status).body(Map.of("code", error.code, "message", error.getMessage()));
    }

    @ExceptionHandler({HttpMessageNotReadableException.class, MethodArgumentTypeMismatchException.class})
    ResponseEntity<Map<String, String>> invalidRequest() {
        return business(ApiFailure.input("请求格式不正确。"));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<Map<String, String>> invalidBody(MethodArgumentNotValidException error) {
        var first = error.getBindingResult().getFieldError();
        return business(ApiFailure.input(first == null ? "请求参数不正确。" : first.getDefaultMessage()));
    }

    @ExceptionHandler(DataAccessException.class)
    ResponseEntity<Map<String, String>> unavailable() {
        return business(new ApiFailure(HttpStatus.SERVICE_UNAVAILABLE, "DATABASE_UNAVAILABLE", "数据服务暂不可用，请稍后重试。"));
    }
}
