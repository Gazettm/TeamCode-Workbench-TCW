package dev.tcw.server;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Set;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
class AccessConfig implements WebMvcConfigurer {
    static final String PRINCIPAL = "tcw.principal";
    private static final Set<String> PUBLIC = Set.of(
        "GET /api/health", "POST /api/auth/register", "POST /api/auth/login");
    private final AuthService auth;

    AccessConfig(AuthService auth) { this.auth = auth; }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new HandlerInterceptor() {
            @Override
            public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
                response.setHeader("Cache-Control", "no-store");
                var route = request.getMethod() + " " + request.getRequestURI().substring(request.getContextPath().length());
                if (!PUBLIC.contains(route)) request.setAttribute(PRINCIPAL, auth.require(request.getHeader("Authorization")));
                return true;
            }
        }).addPathPatterns("/api/**");
    }
}
