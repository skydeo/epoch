#!/bin/sh
# Drop privileges to a non-root user whose UID/GID match the host's, so the
# SQLite file written to the bind-mounted ./data lands with ownership the host
# expects (the linuxserver.io PUID/PGID pattern).
#
# The container starts as root only long enough to remap the pre-created `epoch`
# user/group to the requested PUID/PGID and make the SQLite dir writable, then
# re-execs the real command as that unprivileged user via gosu. A container
# compromise therefore doesn't hand over root.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# -o allows re-using an existing id (e.g. a PGID that collides with a base group).
groupmod -o -g "$PGID" epoch
usermod -o -u "$PUID" epoch

# The DB lives on a mounted volume owned by the host; make sure the runtime user
# can write it.
mkdir -p /data
chown "$PUID:$PGID" /data

exec gosu epoch "$@"
