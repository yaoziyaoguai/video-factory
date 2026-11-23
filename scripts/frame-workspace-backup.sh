#!/usr/bin/env bash
# 用同一条流做备份、校验和回滚。归档密钥在数据卷与备份目录之外独立保存。
frame_backup_prepare() {
  local key_root=$1 temp
  if [[ -n ${FRAME_BACKUP_AGE_RECIPIENT:-} || -n ${FRAME_BACKUP_AGE_IDENTITY:-} ]]; then
    : "${FRAME_BACKUP_AGE_RECIPIENT:?}" "${FRAME_BACKUP_AGE_IDENTITY:?}"
    [[ -r "$FRAME_BACKUP_AGE_IDENTITY" && -z ${FRAME_BACKUP_OPENSSL_CERT:-} && -z ${FRAME_BACKUP_OPENSSL_KEY:-} ]] || return 1
    command -v age >/dev/null || return 1
    frame_archive_name=workspace.tar.gz.age
  else
    command -v openssl >/dev/null || return 1
    if [[ -n ${FRAME_BACKUP_OPENSSL_CERT:-} || -n ${FRAME_BACKUP_OPENSSL_KEY:-} ]]; then
      : "${FRAME_BACKUP_OPENSSL_CERT:?}" "${FRAME_BACKUP_OPENSSL_KEY:?}"
    else
      if [[ ! -d "$key_root" ]]; then
        temp=$(mktemp -d "${key_root}.XXXXXX") || return 1
        if ! openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj '/CN=Frame workspace recovery/' \
          -keyout "$temp/recovery.key" -out "$temp/recovery.crt" 2>"$temp/generate.log"; then
          rm -r "$temp"; return 1
        fi
        rm "$temp/generate.log"
        chmod 600 "$temp/recovery.key" "$temp/recovery.crt"
        mv "$temp" "$key_root"
      fi
      FRAME_BACKUP_OPENSSL_CERT="$key_root/recovery.crt"
      FRAME_BACKUP_OPENSSL_KEY="$key_root/recovery.key"
    fi
    [[ -r "$FRAME_BACKUP_OPENSSL_CERT" && -r "$FRAME_BACKUP_OPENSSL_KEY" ]] || return 1
    frame_archive_name=workspace.tar.gz.cms
  fi
}
frame_backup_encode() {
  if [[ $frame_archive_name == *.age ]]; then age -r "$FRAME_BACKUP_AGE_RECIPIENT"
  else openssl cms -encrypt -aes-256-gcm -binary -stream -outform DER -recip "$FRAME_BACKUP_OPENSSL_CERT"
  fi
}
frame_backup_decode() {
  if [[ $frame_archive_name == *.age ]]; then age --decrypt -i "$FRAME_BACKUP_AGE_IDENTITY" "$1"
  else openssl cms -decrypt -binary -inform DER -in "$1" -recip "$FRAME_BACKUP_OPENSSL_CERT" -inkey "$FRAME_BACKUP_OPENSSL_KEY"
  fi
}
frame_backup_write() {
  local source=$1 directory=$2
  ( set -e -o pipefail; umask 077
    trap 'rm -f "$directory/$frame_archive_name.partial"' EXIT
    tar czf - -C "$source" . | frame_backup_encode > "$directory/$frame_archive_name.partial"
    chmod 600 "$directory/$frame_archive_name.partial"
    frame_backup_decode "$directory/$frame_archive_name.partial" | tar tzf - > "$directory/workspace-files.txt"
    mv "$directory/$frame_archive_name.partial" "$directory/$frame_archive_name"
  )
}
