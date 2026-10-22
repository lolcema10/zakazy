#!/bin/bash
cd "$(dirname "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Нужен Python 3."
  echo "Установите Python и запустите этот файл ещё раз."
  read -r -p "Нажмите Enter, чтобы закрыть окно."
  exit 1
fi
python3 server.py
status=$?
if [ "$status" -ne 0 ]; then
  echo
  echo "Сервер остановился (код $status)."
  read -r -p "Нажмите Enter, чтобы закрыть окно."
fi
