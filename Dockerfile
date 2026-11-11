# ---- 构建阶段：无需构建，纯静态 ----
FROM nginx:1.27-alpine

# 站点文件
COPY index.html /usr/share/nginx/html/index.html
COPY assets/ /usr/share/nginx/html/assets/

# 自定义 nginx 配置：gzip + 缓存 + 安全头
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# 版本标记
ARG APP_VERSION=1.0
RUN echo "${APP_VERSION}" > /usr/share/nginx/html/version.txt

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
