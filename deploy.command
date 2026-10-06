#!/bin/bash
# 双击：部署豆豆写作乐园到美国服务器（64.83.15.173），输出同时保存到 deploy.log
cd "$(dirname "$0")"
bash deploy-us.sh 2>&1 | tee deploy.log
echo; echo "（部署结束，可以关掉这个窗口）"
