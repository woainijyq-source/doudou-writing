# 豆豆写作乐园：美国服务器

核验日期：2026-10-06（America/Los_Angeles）。本目录为独立应用目录，当前未建立 Git 仓库。

## 当前运行位置

- 公网地址： https://write.joyoqoo.fun/
- DNS：`write` 的 A 记录为 `64.83.15.173`；核验时无 AAAA 记录。
- SSH：`root@64.83.15.173`，使用已有 `~/.ssh/id_ed25519_insurance_crm_us`。
- 应用目录：`/www/wwwroot/doudou-writing`。
- PM2：`doudou-writing`，入口 `serve.mjs`。
- 监听：`127.0.0.1:8793`。8791、8792 已由其他应用使用，不能停止它们来腾出端口。
- Nginx：`/etc/nginx/sites-available/doudou-writing`，由 `sites-enabled` 中的符号链接启用。
- TLS：`/etc/letsencrypt/live/write.joyoqoo.fun/`；HTTP 跳转 HTTPS，`certbot.timer` 与已有 Nginx 续期 reload hook 已启用。
- 作品与备份：应用目录下的 `data/`；语音缓存：`tts-cache/`。

## 火山引擎语音

- 服务端 `POST /api/tts` 使用火山豆包语音，登录家庭口令后调用。
- `VOLC_TTS_KEY` 从服务端 `.env` 读取，已按用户要求与 KET 项目运行中的语音配置统一。
- `VOLC_TTS_RESOURCE=seed-tts-2.0`；默认接口为 `https://openspeech.bytedance.com/api/v3/tts/unidirectional`。
- 默认音色为小何 `zh_female_xiaohe_uranus_bigtts`，前端默认语速 `-10`。
- `.env` 权限为 `600`。密钥、家庭口令、Cookie 不应打印、提交或写入本文档。

## 更新与验证

完整部署入口为 `deploy-us.sh`，会修改 AI 配置、重启本应用并配置 Nginx；执行前先阅读脚本并核对范围。只修改语音配置时应仅更新必要的 TTS 环境项，保留 `APP_PASSWORD`、`SESSION_SECRET`、AI 配置和 `data/`，随后仅重启 `doudou-writing`。任何部署前先检查当前端口占用和远端状态。

本次未上传或修改应用源码，实际更新服务端 `.env` 中的 TTS 密钥与端口，并补齐独立站点、HTTPS 配置。变更前备份保存在服务器 `/root/doudou-writing-backups/20261006T063209Z-tts/`。

完成标准：PM2 在线；服务器本地 `http://127.0.0.1:8793/api/health` 与公网 `https://write.joyoqoo.fun/api/health` 返回正常；严格 TLS 校验通过；经已有家庭口令登录后，用未缓存短句调用 `/api/tts` 并验证实际 MP3。健康检查的 `tts: true` 仅表示已填密钥，不能代替真实合成测试。

本次核验：公网未缓存合成 HTTP 200，`audio/mpeg`，59,181 字节，MP3 / 24kHz / 单声道 / 7.392 秒；浏览器可正常打开 HTTPS 首页与家庭口令登录页。未进行实体 iPhone/iPad 扬声器播放测试。

## AI

- `AI_BASE=https://doudou-newapi.com`。
- `AI_MODEL=DeepSeek-V4.1-Flash`。
- `AI_KEY` 只保存在服务器 `.env`（权限 `600`），不写入本文档或前端页面。
- 本次更新后仅重启 `doudou-writing`，健康检查正常；家庭口令登录后公网 `/api/chat` 返回 HTTP 200，指定模型返回 `OK`。
