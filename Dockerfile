# ============================================================
# 纸杯报价系统 · 生产镜像
# 基础镜像：nginx alpine（体积 ~50MB）
# 监听：0.0.0.0:80
# ============================================================
FROM nginx:1.27-alpine

LABEL org.opencontainers.image.title="Paper Cup Quotation System" \
      org.opencontainers.image.description="纸杯报价系统 - 成本核算 / 报价单 / 合同导出" \
      org.opencontainers.image.version="1.2" \
      org.opencontainers.image.licenses="MIT"

# 时区（日志时间与国内一致）
RUN apk add --no-cache tzdata \
 && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
 && echo "Asia/Shanghai" > /etc/timezone \
 && apk del tzdata

# 站点文件
COPY index.html /usr/share/nginx/html/index.html
COPY assets/    /usr/share/nginx/html/assets/

# 资源版本号：index.html 里引用脚本/样式的地址是 assets/xxx?v=__V__，
# 构建时把 __V__ 换成提交号（--build-arg ASSET_V=xxx）。地址一变，浏览器必定下载新文件，
# 不会再出现「服务器已更新、浏览器还在用旧脚本」
ARG ASSET_V=dev
RUN sed -i "s/__V__/${ASSET_V}/g" /usr/share/nginx/html/index.html

# nginx 配置（含 listen 0.0.0.0:80、gzip、缓存、安全头）
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# 版本标记，可通过 /version.txt 查看
ARG APP_VERSION=1.2
RUN echo "${APP_VERSION}" > /usr/share/nginx/html/version.txt

# 确保 nginx 以非 root 用户可写临时目录（alpine 镜像默认已处理，这里显式声明）
RUN chown -R nginx:nginx /usr/share/nginx/html \
 && chmod -R 755 /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1

STOPSIGNAL SIGQUIT

CMD ["nginx", "-g", "daemon off;"]
