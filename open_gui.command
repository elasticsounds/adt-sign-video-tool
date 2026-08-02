#!/bin/zsh
set -e

tool_directory=${0:A:h}
adt_directory=${1:-}

if [[ -z "$adt_directory" ]]; then
  echo "ADT Sign Video Tool"
  echo "Drag an exported ADT folder into this window, then press Return:"
  read -r adt_directory
fi

adt_directory=${adt_directory#\'}
adt_directory=${adt_directory%\'}
adt_directory=${adt_directory#\"}
adt_directory=${adt_directory%\"}

exec python3 "$tool_directory/gui_server.py" "$adt_directory"
