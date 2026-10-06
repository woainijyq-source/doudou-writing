#!/bin/bash
# 双击启动豆豆写作乐园（需要 Node.js 18 以上）。用完关掉这个窗口即可。
cd "$(dirname "$0")"
PORT=8765

fail(){ echo; echo "❌ $*"; echo; read -r -p "按回车键关闭窗口……" _; exit 1; }

# 已经在运行了：直接打开网页
if curl -fsS -m 2 "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
  echo "豆豆写作乐园已经在运行，直接打开网页。"
  open "http://localhost:${PORT}/"
  sleep 2; exit 0
fi

# 找 Node：PATH、Homebrew、官方安装包、nvm、volta、fnm
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.volta/bin:${PATH}"
if ! command -v node >/dev/null 2>&1; then
  [ -s "${HOME}/.nvm/nvm.sh" ] && . "${HOME}/.nvm/nvm.sh" >/dev/null 2>&1
fi
if ! command -v node >/dev/null 2>&1; then
  for d in "${HOME}"/.nvm/versions/node/*/bin "${HOME}"/.local/share/fnm/node-versions/*/installation/bin; do
    [ -x "$d/node" ] && export PATH="$d:${PATH}"
  done
fi
command -v node >/dev/null 2>&1 || fail "这台电脑没有找到 Node.js。请到 https://nodejs.org 下载安装 LTS 版，装好后再双击我。"

MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
[ "${MAJOR:-0}" -ge 18 ] || fail "Node.js 版本太旧（现在是 $(node -v)），需要 18 以上。请到 https://nodejs.org 安装新版。"
[ -f .env ] || echo "⚠️  没找到 .env，豆包语音和 AI 可能用不了。"

echo "用 Node $(node -v) 启动……"
node serve.mjs || fail "启动失败（上面是出错信息）。如果写着 EADDRINUSE，说明 ${PORT} 端口被占用了：重启电脑或关掉之前的窗口再试。"
