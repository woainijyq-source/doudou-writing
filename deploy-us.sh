#!/usr/bin/env bash
# 豆豆写作乐园 · 部署到美国服务器（64.83.15.173，和保险管理系统、doudou-newapi 同一台）
# AI 走 doudou-newapi.com（DeepSeek-V4.1-Flash），Key 从本机 .env 的 AI_KEY 读取，只存在服务器 .env 里
# 用法：在本文件夹里运行  bash deploy-us.sh
#   第一次部署会问你“家庭口令”，之后再部署会保留服务器上的口令和数据。
# 可用环境变量覆盖：SERVER SSH_KEY DOMAIN PORT REMOTE_PATH APP_PASSWORD AI_MODEL
set -euo pipefail
cd "$(dirname "$0")"

SERVER="${SERVER:-root@64.83.15.173}"
SERVER_IP="${SERVER#*@}"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/id_ed25519_insurance_crm_us}"
DOMAIN="${DOMAIN:-write.joyoqoo.fun}"
PORT="${PORT:-8791}"
REMOTE_PATH="${REMOTE_PATH:-/www/wwwroot/doudou-writing}"
PM2_NAME="doudou-writing"
NGINX_CONF="/etc/nginx/sites-available/doudou-writing"

SSH=(ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 "${SERVER}")
SCP=(scp -i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)

say(){ printf '\n\033[1;33m▶ %s\033[0m\n' "$*"; }

say "1/6 检查本地文件和服务器连接"
for f in doudou-writing.html serve.mjs; do [ -f "${f}" ] || { echo "缺少 ${f}"; exit 1; }; done
[ -f "${SSH_KEY}" ] || { echo "找不到 SSH 密钥 ${SSH_KEY}"; exit 1; }
"${SSH[@]}" "echo 已连接：\$(hostname)；Node \$(node -v 2>/dev/null || echo 未安装)；PM2 \$(pm2 -v 2>/dev/null || echo 未安装)"

# 本地密钥：都在本机 .env 里
envget(){ grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r' || true; }
AI_BASE_L="$(envget AI_BASE)"; AI_BASE_L="${AI_BASE_L:-https://doudou-newapi.com}"
AI_KEY_L="$(envget AI_KEY)"
AI_MODEL_L="${AI_MODEL:-$(envget AI_MODEL)}"; AI_MODEL_L="${AI_MODEL_L:-DeepSeek-V4.1-Flash}"
[ -n "${AI_KEY_L}" ] || { echo "本机 .env 里没有 AI_KEY"; exit 1; }
VOLC_TTS_KEY="$(grep -E '^VOLC_TTS_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)"

say "2/6 上传程序"
TMP="$(mktemp -d)"; trap 'rm -rf "${TMP}"' EXIT
COPYFILE_DISABLE=1 tar -czf "${TMP}/app.tgz" doudou-writing.html serve.mjs
"${SCP[@]}" "${TMP}/app.tgz" "${SERVER}:/tmp/doudou-writing.tgz"
"${SSH[@]}" "mkdir -p '${REMOTE_PATH}/data' '${REMOTE_PATH}/logs' && tar -xzf /tmp/doudou-writing.tgz -C '${REMOTE_PATH}' && rm -f /tmp/doudou-writing.tgz"

say "3/6 配置（家庭口令和作品数据会保留）"
if "${SSH[@]}" "test -f '${REMOTE_PATH}/.env'"; then
  echo "服务器上已有 .env，保留原来的家庭口令。"
else
  if [ -z "${APP_PASSWORD:-}" ]; then
    read -r -p "请设置家庭口令（孩子登录用，至少4个字）：" APP_PASSWORD
  fi
  [ "${#APP_PASSWORD}" -ge 4 ] || { echo "口令太短"; exit 1; }
  SECRET="$(openssl rand -hex 32)"
  printf 'APP_PASSWORD=%s\nSESSION_SECRET=%s\n' "${APP_PASSWORD}" "${SECRET}" > "${TMP}/env"
  "${SCP[@]}" "${TMP}/env" "${SERVER}:${REMOTE_PATH}/.env"
  "${SSH[@]}" "chmod 600 '${REMOTE_PATH}/.env'"
fi
# AI 和朗读的配置：写成小文件传上去再合并进服务器 .env（Key 不出现在命令行里）
printf 'AI_BASE=%s\nAI_KEY=%s\nAI_MODEL=%s\nHOST=127.0.0.1\nDATA_DIR=%s\n' "${AI_BASE_L}" "${AI_KEY_L}" "${AI_MODEL_L}" "${REMOTE_PATH}/data" > "${TMP}/ai.env"
[ -n "${VOLC_TTS_KEY}" ] && printf 'VOLC_TTS_KEY=%s\n' "${VOLC_TTS_KEY}" >> "${TMP}/ai.env"
"${SCP[@]}" "${TMP}/ai.env" "${SERVER}:/tmp/doudou-ai.env"
"${SSH[@]}" "bash -s -- '${REMOTE_PATH}/.env' /tmp/doudou-ai.env" <<'REMOTE'
f="$1"; src="$2"
while IFS= read -r line; do
  k="${line%%=*}"; [ -n "$k" ] || continue
  grep -vE "^$k=" "$f" > "$f.tmp"; echo "$line" >> "$f.tmp"; cat "$f.tmp" > "$f"; rm -f "$f.tmp"
done < "$src"
rm -f "$src"
grep -qE '^VOLC_TTS_RESOURCE=' "$f" || echo "VOLC_TTS_RESOURCE=seed-tts-2.0" >> "$f"
chmod 600 "$f"
echo "AI 通道：$(grep -E '^AI_BASE=' "$f" | cut -d= -f2-)（模型 $(grep -E '^AI_MODEL=' "$f" | cut -d= -f2-)）"
REMOTE


say "4/6 启动服务（PM2：${PM2_NAME}）"
# 先停掉旧进程；端口被别的程序占用就自动换一个空闲端口，并写回服务器 .env
STEP4="$("${SSH[@]}" "bash -s -- '${REMOTE_PATH}' '${PORT}' '${PM2_NAME}'" <<'REMOTE'
RP="$1"; PORT="$2"; NAME="$3"
cd "$RP" || exit 1
pm2 delete "$NAME" >/dev/null 2>&1 || true
sleep 1
cur="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2 | tr -d ' "\r')"
p="${cur:-$PORT}"
busy(){ ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }
if busy "$p"; then
  echo "端口 $p 已被别的程序占用：$(ss -ltnp 2>/dev/null | grep -E "[:.]$p " | head -1 | sed -E 's/.*users:/users:/')"
  while busy "$p"; do p=$((p+1)); done
  echo "改用空闲端口 $p"
fi
if grep -qE '^PORT=' .env; then sed -i -E "s/^PORT=.*/PORT=$p/" .env; else echo "PORT=$p" >> .env; fi
grep -qE '^HOST=' .env || echo "HOST=127.0.0.1" >> .env
pm2 start serve.mjs --name "$NAME" --cwd "$RP" -o "$RP/logs/out.log" -e "$RP/logs/err.log" --time >/dev/null
pm2 save >/dev/null
for i in $(seq 1 15); do
  out="$(curl -fsS "http://127.0.0.1:$p/api/health" 2>/dev/null)"
  if echo "$out" | grep -q '"store"'; then echo "健康检查通过：$out"; echo "PORT_OK=$p"; exit 0; fi
  sleep 1
done
echo "❌ 服务没有正常启动，最近日志："
pm2 logs "$NAME" --lines 40 --nostream 2>&1 | tail -60
exit 1
REMOTE
)" || { echo "${STEP4}"; exit 1; }
echo "${STEP4}" | grep -v '^PORT_OK='
PORT="$(echo "${STEP4}" | sed -n 's/^PORT_OK=//p' | tail -1)"
[ -n "${PORT}" ] || { echo "拿不到服务端口"; exit 1; }
echo "测试豆豆老师的 AI（服务器直连 ${AI_BASE_L}）……"
"${SSH[@]}" "bash -s -- '${REMOTE_PATH}/.env'" <<'REMOTE' || true
f="$1"; v(){ grep -E "^$1=" "$f" | tail -1 | cut -d= -f2-; }
body=$(printf '{"model":"%s","messages":[{"role":"user","content":"只回答：你好"}],"max_tokens":20}' "$(v AI_MODEL)")
code=$(curl -sS -m 60 "$(v AI_BASE)/v1/chat/completions" -H 'Content-Type: application/json' -H "Authorization: Bearer $(v AI_KEY)" -d "$body" -o /tmp/dd-ai-test.json -w '%{http_code}')
echo "AI 测试：HTTP $code"; head -c 300 /tmp/dd-ai-test.json; echo; rm -f /tmp/dd-ai-test.json
REMOTE

# 识别服务器 Nginx 的配置目录
NGINX_LAYOUT="$("${SSH[@]}" "export PATH=\$PATH:/www/server/nginx/sbin; if nginx -T 2>/dev/null | grep -q 'sites-enabled'; then echo debian; elif [ -d /www/server/panel/vhost/nginx ]; then echo bt; else echo confd; fi")"
case "${NGINX_LAYOUT}" in
  bt)    NGINX_CONF="/www/server/panel/vhost/nginx/doudou-writing.conf"; NGINX_LINK="" ;;
  confd) NGINX_CONF="/etc/nginx/conf.d/doudou-writing.conf"; NGINX_LINK="" ;;
  *)     NGINX_LINK="/etc/nginx/sites-enabled/doudou-writing" ;;
esac
echo "Nginx 配置文件：${NGINX_CONF}"

say "5/6 配置 Nginx 和 HTTPS（${DOMAIN}）"
DNS_IP="$("${SSH[@]}" "getent ahostsv4 '${DOMAIN}' 2>/dev/null | awk '{print \$1; exit}'" || true)"
HAS_CERT="$("${SSH[@]}" "test -f /etc/letsencrypt/live/${DOMAIN}/fullchain.pem && echo yes || echo no")"

http_block="server {
    listen 80;
    server_name ${DOMAIN};
    client_max_body_size 5m;
    location ^~ /.well-known/acme-challenge/ { root /var/www/certbot; default_type text/plain; try_files \$uri =404; }
    location / {"
proxy_block="        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
    }"

write_conf(){  # $1 = with_https(yes/no)
  if [ "$1" = yes ]; then
    cat > "${TMP}/nginx.conf" <<EOF
${http_block}
        return 301 https://\$host\$request_uri;
    }
}
server {
    listen 443 ssl http2;
    server_name ${DOMAIN};
    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 5m;
    location / {
${proxy_block}
    access_log ${REMOTE_PATH}/logs/nginx-access.log;
    error_log ${REMOTE_PATH}/logs/nginx-error.log;
}
EOF
  else
    cat > "${TMP}/nginx.conf" <<EOF
${http_block}
${proxy_block}
    access_log ${REMOTE_PATH}/logs/nginx-access.log;
    error_log ${REMOTE_PATH}/logs/nginx-error.log;
}
EOF
  fi
  "${SCP[@]}" "${TMP}/nginx.conf" "${SERVER}:/tmp/doudou-writing.nginx"
  "${SSH[@]}" "export PATH=\$PATH:/www/server/nginx/sbin; mkdir -p /var/www/certbot && cp '${NGINX_CONF}' '${NGINX_CONF}.bak' 2>/dev/null; install -m 644 /tmp/doudou-writing.nginx '${NGINX_CONF}' && { [ -z '${NGINX_LINK}' ] || ln -sf '${NGINX_CONF}' '${NGINX_LINK}'; } && nginx -t && { systemctl reload nginx 2>/dev/null || nginx -s reload; } && rm -f /tmp/doudou-writing.nginx"
}

if [ "${HAS_CERT}" = yes ]; then
  write_conf yes
elif [ "${DNS_IP}" = "${SERVER_IP}" ]; then
  write_conf no
  echo "申请 HTTPS 证书……"
  "${SSH[@]}" "command -v certbot >/dev/null || (apt-get install -y certbot >/dev/null 2>&1 || yum install -y certbot >/dev/null 2>&1); certbot certonly --webroot -w /var/www/certbot -d '${DOMAIN}' --non-interactive --agree-tos --register-unsafely-without-email"
  write_conf yes
else
  write_conf no
  echo
  echo "⚠️  域名 ${DOMAIN} 还没有指向这台服务器（现在解析到：${DNS_IP:-没有记录}）。"
  echo "   请在 joyoqoo.fun 的域名解析里加一条：主机记录 write，类型 A，记录值 ${SERVER_IP}"
  echo "   生效后（通常几分钟）再运行一次 bash deploy-us.sh，就会自动配好 HTTPS。"
fi

say "6/6 检查"
"${SSH[@]}" "curl -fsS -H 'Host: ${DOMAIN}' http://127.0.0.1/api/health -o /dev/null -w 'Nginx 转发：HTTP %{http_code}\n' || true"
"${SSH[@]}" "curl -sS --resolve '${DOMAIN}:443:127.0.0.1' https://${DOMAIN}/api/health -o /dev/null -w 'HTTPS（证书校验）：HTTP %{http_code}\n' 2>&1 || true"
if [ "${HAS_CERT}" = yes ] || [ "${DNS_IP}" = "${SERVER_IP}" ]; then
  echo; echo "✅ 部署完成：https://${DOMAIN}/"
fi
echo "数据目录：${SERVER}:${REMOTE_PATH}/data（每天自动备份作品到 data/backups）"
