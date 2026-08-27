#!/bin/zsh

script_dir="${0:A:h}"
cd "$script_dir" || exit 1

node_bin="$(command -v node)"
if [[ -z "$node_bin" ]]; then
  echo "没有找到 Node.js，无法管理热力图同步。"
  read "?按回车关闭…"
  exit 1
fi

"$node_bin" scripts/sync-control.js menu
status_code=$?
echo
read "?按回车关闭…"
exit $status_code
