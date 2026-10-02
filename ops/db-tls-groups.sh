#!/usr/bin/env bash
# Shows which TLS key-exchange group a container's database connections actually negotiate.
# Captures port 5432 inside the container's network namespace for N seconds and prints the
# groups offered in each ClientHello and the group chosen in each ServerHello.
#   4588 = X25519MLKEM768 (post-quantum hybrid)   29 = X25519 (classical)
# usage: scripts/db-tls-groups.sh <container> [seconds] [-- command to run meanwhile]
set -euo pipefail
C="${1:?usage: $0 <container> [seconds] [-- cmd...]}"; shift
SECS=10; [ $# -gt 0 ] && [ "$1" != "--" ] && { SECS=$1; shift; }
[ "${1:-}" = "--" ] && shift
IMG=tls-capture:trixie
docker image inspect "$IMG" >/dev/null 2>&1 || printf 'FROM debian:trixie-slim\nRUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tshark tcpdump && rm -rf /var/lib/apt/lists/*\n' | docker build -q -t "$IMG" - >/dev/null
CAP=$(docker run -d --network "container:$C" --cap-add NET_RAW --cap-add NET_ADMIN "$IMG" \
  sh -c "timeout $SECS tcpdump -i any -U -w /tmp/c.pcap port 5432 >/dev/null 2>&1; \
         echo 'ClientHello key_share groups offered:'; tshark -r /tmp/c.pcap -Y 'tls.handshake.type==1' -T fields -e tls.handshake.extensions_key_share_group 2>/dev/null | sort | uniq -c; \
         echo 'ServerHello key_share group selected:';  tshark -r /tmp/c.pcap -Y 'tls.handshake.type==2' -T fields -e tls.handshake.extensions_key_share_group 2>/dev/null | sort | uniq -c")
sleep 1
[ $# -gt 0 ] && "$@" >/dev/null 2>&1 || true
docker wait "$CAP" >/dev/null
docker logs "$CAP"
docker rm "$CAP" >/dev/null
