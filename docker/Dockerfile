# ---------------------------------------------------------------------------
# CodeGuard AI 生产镜像
# 特性：多阶段构建 · 非 root 运行 · 零运行时第三方依赖 · 内置健康检查
# ---------------------------------------------------------------------------

# ============================ 构建阶段 ============================
# 本项目运行时零第三方依赖，构建阶段仅用于生成一个干净的依赖树，
# 这样即使将来引入构建期工具，也不会污染运行镜像。
FROM node:20-alpine AS builder

WORKDIR /build

# 先复制清单文件，最大化利用 Docker 层缓存
COPY package.json ./

# 本项目 dependencies / devDependencies 均为空，此步骤不会下载任何包；
# 保留该步骤是为了让标准流程在将来引入依赖时依然正确。
RUN npm install --omit=dev --no-audit --no-fund

# ============================ 运行阶段 ============================
FROM node:20-alpine AS runtime

LABEL org.opencontainers.image.title="CodeGuard AI" \
      org.opencontainers.image.description="面向开发者的 AI 代码审查 Agent：静态规则引擎 + 多角色大模型语义评审" \
      org.opencontainers.image.licenses="MIT"

# 安装最小运行依赖：dumb-init 负责正确转发信号，tini 亦可；这里用 dumb-init
RUN apk add --no-cache dumb-init \
    && addgroup -g 10001 -S codeguard \
    && adduser -u 10001 -S codeguard -G codeguard

WORKDIR /app

# 复制依赖与源码（仅复制运行所需内容，不携带测试与文档以减少体积）
COPY --from=builder /build/node_modules ./node_modules
COPY package.json ./
COPY bin/ ./bin/
COPY src/ ./src/
COPY web/ ./web/
COPY .env.example ./

# 数据目录需可写，且归属非 root 用户
RUN mkdir -p /app/data && chown -R codeguard:codeguard /app

USER codeguard

# ---------------------------- 运行时配置 ----------------------------
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8848 \
    LOG_FORMAT=json \
    LOG_LEVEL=info \
    DATA_DIR=/app/data

EXPOSE 8848

# 健康检查：容器编排据此判断实例是否可用
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8848)+'/api/meta/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

# 使用 dumb-init 作为 PID 1，保证 SIGTERM 能正确送达 Node 进程以触发优雅退出
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
