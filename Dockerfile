# ============================================================
# 纸杯报价系统 · 生产镜像
# 一个 Node 进程同时负责：提供网页 + 已保存报价单的存取接口
# 监听：0.0.0.0:3000（以非 root 用户运行，所以不用 80）
# 数据：/data（已保存的报价单，必须挂到宿主机，否则容器重建就丢）
# ============================================================
FROM node:22-alpine

LABEL org.opencontainers.image.title="Paper Cup Quotation System" \
      org.opencontainers.image.description="纸杯报价系统 - 成本核算 / 报价单 / 合同导出" \
      org.opencontainers.image.version="1.3" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    DATA=/data \
    PORT=3000

WORKDIR /app

# 网页文件
COPY index.html public/index.html
COPY assets/    public/assets/

# 服务端
COPY server/ server/

# 版本号：①资源地址 assets/xxx?v=__V__ 构建时换成提交号（--build-arg ASSET_V=xxx），
#         地址一变浏览器必定下载新文件；②/version.txt 可查看
ARG APP_VERSION=1.3
ARG ASSET_V=dev
RUN sed -i "s/__V__/${ASSET_V}/g" public/index.html \
 && echo "app=${APP_VERSION} commit=${ASSET_V}" > public/version.txt \
 && chown -R node:node /app

# 数据目录归运行用户所有（镜像里先建好，宿主机挂载时再 chown）
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server/server.js"]
