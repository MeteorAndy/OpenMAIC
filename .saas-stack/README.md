# OpenMAIC SaaS 部署手册(feat/saas)

> 目标读者:运营/部署者。架构细节见 `SAAS_DESIGN.md`,本文只讲"怎么把它跑起来、守住、接支付"。

## 1. 架构

```
浏览器
  │  https://your-domain
  ▼
Next.js(纯 UI,:3000)── /api/* 同源代理(NEXT_PUBLIC_BACKEND_URL)──▶ 编译后端 Bun 二进制(:8787)
  │                                                                    │ 提示词已烘入二进制
  ▼                                                                    ▼
Supabase Kong(:8000)◀────────── GoTrue 鉴权 / PostgREST / Storage / Realtime ── Postgres(:5432)
                                                                       Redis(:6379,限流+队列)
```

- Next 构建产物**不含任何服务端逻辑**(`app/api` 已归档为 `app/_api_archive`,不进构建);所有 `/api/*` 由编译后端承接。
- 用户鉴权:Supabase GoTrue,ES256 JWT,后端经 JWKS 无状态校验。
- 数据:Postgres 服务端权威(RLS 开启),业务表经 Drizzle 管理。

## 2. 组件与端口

| 组件 | 来源 | 默认端口 | 说明 |
|---|---|---|---|
| Supabase 全家桶 | `.saas-stack/docker-compose.yml` | 8000(Kong)/5432(DB)/6379(Redis) | 含 Studio(:3001 经 Kong /) |
| 编译后端 | `backend/` → `bun build --compile` | 8787 | 全部 API + 编排 + 提示词 |
| Next 前端 | 根目录 `pnpm build`(standalone) | 3000 | 纯 UI + 代理 |

## 3. 首次部署

```bash
# 0. 准备:Docker + bun + pnpm
git checkout feat/saas && pnpm install

# 1. Supabase 栈
cp .saas-stack/.env.example .saas-stack/.env
#   编辑 .env:POSTGRES_PASSWORD、JWT_SECRET、ANON_KEY/SERVICE_ROLE_KEY(或
#   ANON_KEY_ASYMMETRIC 一对 ES256 JWK)、DASHBOARD_PASSWORD、SITE_URL、SMTP_*(见 §5)
docker compose -f .saas-stack/docker-compose.yml --env-file .saas-stack/.env up -d

# 2. 应用环境(仓库根)
cp .env.example .env.local
#   NEXT_PUBLIC_SUPABASE_URL=http(s)://<kong 入口>   ANON/SERVICE 键与上一步一致
#   DATABASE_URL=postgresql://postgres:<密码>@<host>:5432/postgres
#   REDIS_URL=redis://<host>:6379
#   NEXT_PUBLIC_BACKEND_URL=http://<backend-host>:8787
#   ADMIN_USER_IDS=<你的运营账号 userId,逗号分隔>

# 3. 数据库初始化(幂等,按序)
pnpm db:migrate
psql "$DATABASE_URL" -f db/c2_prereqs.sql
psql "$DATABASE_URL" -f db/rls.sql
psql "$DATABASE_URL" -f db/realtime.sql
pnpm db:seed            # free/pro/team 套餐

# 4. 对象存储桶(一次性)
node scripts/create-storage-bucket.mjs

# 5. 编译后端并运行
cd backend && bun run build   # 产出二进制;拷到目标机,配好上面的 env 直接跑
./openmaic-backend            # 监听 :8787

# 6. 前端
pnpm build && pnpm start      # 或 standalone: node .next/standalone/server.js
```

验证:`curl http://localhost:3000/api/health` 应经代理打到后端并返回 200;注册一个账号,Studio 里能看到用户。

## 4. 邮件(GoTrue SMTP)

注册确认、找回密码由 **GoTrue** 直接发送,与应用代码无关。在 `.saas-stack/.env` 配:

```bash
SMTP_HOST=smtp.163.com   # 或 SES / Resend SMTP / QQ 邮箱
SMTP_PORT=465
SMTP_USER=...
SMTP_PASS=...
SMTP_ADMIN_EMAIL=no-reply@your-domain
ENABLE_EMAIL_AUTOCONFIRM=false   # 生产必须 false(开发可 true 跳过验证)
```

应用级事务邮件(收据/配额告警)走 `lib/server/email.ts` 接缝:默认 `EMAIL_PROVIDER=log`(只记日志不发送),实现 `EmailProvider` 后注册即可。

## 5. 备份与恢复

```bash
# 数据库(auth + 业务全量,默认保留 14 份)
scripts/backup-saas-db.sh /var/backups/openmaic
# 建议 cron:17 3 * * * /path/to/scripts/backup-saas-db.sh /var/backups/openmaic

# 恢复
gunzip -c /var/backups/openmaic/openmaic-saas-<ts>.sql.gz | docker exec -i supabase-db psql -U postgres -d postgres
```

- `.saas-stack/volumes/db/data/`(Postgres)与 `volumes/storage/`(用户上传)是唯一不可重建的状态,按上面脚本 + 目录级快照双保险。
- Redis 数据可重建,不备份。

## 6. 日常运营

- **开通/调整套餐**:访问 `/admin`(账号需在 `ADMIN_USER_IDS`),或
  `curl -X POST $BACKEND/api/admin/subscription -H "Authorization: Bearer <admin JWT>" -d '{"userId":"...","planId":"pro"}'`
- **查用户邮箱/封禁**:Supabase Studio(`http://<kong>/` → DASHBOARD 账密)。admin API 只管套餐与用量。
- **看用量**:`/admin` 表格,或 `GET /api/admin/users`。

## 7. 支付接入(给客户/渠道接线时读)

接缝已就位,接 Stripe / 微信支付 / 支付宝只需三步,**不改业务代码**:

1. 新建 `lib/server/billing-<provider>.ts` 实现 `BillingProvider`(见 `lib/server/billing.ts` 顶部文档):
   - `createCheckoutSession`:跳 provider 收银台,**把我们的 userId 塞进 metadata**;
   - `handleWebhook`:验签后调现成的 `setUserPlan(userId, planId, period)` / `cancelUserPlan(userId)` —— 所有 DB 写入都在 billing.ts 里,provider 保持无状态;
2. 在 `billing.ts` 的 `providers` 表里注册;
3. 配 env:`BILLING_PROVIDER=<id>` + provider 密钥。

接线点:前端 `/pricing` 页 CTA → `POST /api/billing/checkout` 拿 `checkoutUrl` 跳转;provider 回调 → `POST /api/billing/webhook`(公网可达,验签在 provider 内)。过渡期:客户线下付款,运营用 §6 手动开通,体验完整可用。

## 8. 上线安全检查清单

- [ ] `.saas-stack/.env` 全部默认密钥已更换(POSTGRES_PASSWORD / JWT_SECRET / DASHBOARD_PASSWORD / SECRET_KEY_BASE / S3 密钥)
- [ ] `ENABLE_EMAIL_AUTOCONFIRM=false`
- [ ] `DISABLE_SIGNUP` 按需(开放注册则 false)
- [ ] HTTPS 终结(前置 Caddy/Nginx),`SITE_URL` / `ADDITIONAL_REDIRECT_URLS` 与域名一致
- [ ] `ADMIN_USER_IDS` 只含运营账号
- [ ] Kong 8000 不直接暴露公网(仅 Next 与后端可达),对外只开 443
- [ ] 备份 cron 已跑通过一次,且**演练过恢复**
- [ ] `RATE_LIMIT_PER_MINUTE` 按客群调好(默认 30)

## 9. 已知边界(设计文档明确 deferred,接单前评估)

- team/org 多席位、细粒度限流、同步冲突解决(现 last-write-wins)、桌面版本地数据迁移
- 管理后台为极简版(套餐+用量);无用户管理 UI(用 Studio)
- Landing 页只有 `/pricing`,无营销站点
