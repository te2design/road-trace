#!/bin/bash
# Road Trace 起動スクリプト
# ダブルクリックすると、ローカルWebサーバーを起動してブラウザでアプリを開きます。
# 終了するときは、このウィンドウで Ctrl+C を押すか、ウィンドウを閉じてください。
cd "$(dirname "$0")"
PORT=8765

echo "Road Trace を起動します… http://localhost:${PORT}"
( sleep 1.2; open "http://localhost:${PORT}" ) &

if command -v python3 >/dev/null 2>&1; then
  python3 -m http.server ${PORT}
elif command -v npx >/dev/null 2>&1; then
  npx --yes http-server -p ${PORT} -c-1 .
else
  echo "python3 が見つかりません。App Storeまたは https://www.python.org からPythonを入れるか、"
  echo "ターミナルで『xcode-select --install』を実行してください。"
  read -r -p "Enterで終了"
fi
