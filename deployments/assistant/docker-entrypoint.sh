#!/bin/sh
set -e

target="${BASEDIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$target"
  # New named volumes inherit ownership from the image, but existing volumes and
  # bind mounts can be root-owned. Fix that before dropping to the runtime user.
  chown -R bun:bun "$target"
  exec su-exec bun "$@"
fi

exec "$@"
