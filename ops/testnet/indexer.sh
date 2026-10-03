#!/usr/bin/env bash
# The Envio indexer over Monad testnet (chain 10143) by RPC sync, for a local run (the hosted service later uses
# HyperSync and needs none of this).
#
#   ops/testnet/indexer.sh run [--fork] [--dry-run]     (the shared-indexer window of up.sh runs this)
#   ops/testnet/indexer.sh stop [--fork] [--dry-run]    (envio stop: its Postgres and Hasura containers and database go)
#
# It copies indexer/ into $AGATE_KIT_STATE/indexer (node_modules linked, nothing installed; the repo's committed
# config.yaml and src/lib/deployments.generated.ts never change), renders config.yaml there from the deployments file
# with --rpc and each index's deploy block (--index-start real=<block> demo=<block>), and starts `envio dev`, which
# runs Postgres and Hasura in containers (Docker or Podman must answer `docker info`; start Podman with
# `podman machine start`). The RPC URL comes from AGATE_RPC_URLS_CMD at start (its first http(s) entry: Alchemy on
# testnet) into ENVIO_RPC_URL of the envio process only: never written to config.yaml or any file, never printed.
# A config different from the last run's restarts indexing from scratch (envio dev -r).
#
# GraphQL: http://localhost:8080/v1/graphql (Hasura; unauthenticated reads use the public role, admin secret
# "testing" in envio dev). No app code reads a GraphQL endpoint yet (RUNBOOK.md, "The indexer and the app").
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

kit_parse "$@"
case "${KIT_POS[0]:-}" in run | stop) ;; *) die "usage: $0 <run|stop> [--fork] [--dry-run]" ;; esac
need_tools bun jq
DEP="${AGATE_DEPLOYMENTS:-$KIT_DEPLOYMENTS}"
REC="${AGATE_KIT_RECORDS:-$KIT_RECORDS}"
WORK="$KIT_STATE/indexer"

# envio talks to the Docker API: Docker's socket, or Podman's (DOCKER_HOST is set from `podman machine inspect`)
docker_host() {
  if [ -z "${DOCKER_HOST:-}" ] && command -v podman >/dev/null 2>&1; then
    SOCK="$(podman machine inspect --format '{{.ConnectionInfo.PodmanSocket.Path}}' 2>/dev/null || true)"
    if [ -n "$SOCK" ] && [ -S "$SOCK" ]; then export DOCKER_HOST="unix://$SOCK"; fi
  fi
  return 0
}

# stop: the shared-indexer window's Ctrl-C ends `envio dev` but leaves its containers running (a restart resumes from
# them); this removes them, and the database with them (the next run indexes again from the deploy blocks)
if [ "${KIT_POS[0]}" = stop ]; then
  show "(cd $WORK && envio stop)"
  [ "$KIT_DRY" = 1 ] && exit 0
  [ -x "$WORK/node_modules/.bin/envio" ] || { note "no indexer in $WORK: nothing to stop"; exit 0; }
  docker_host
  docker info >/dev/null 2>&1 || { note "no Docker or Podman answers: nothing to stop"; exit 0; }
  # envio reads config.yaml, whose RPC URL is ENVIO_RPC_URL: a placeholder, since stop contacts no chain
  (cd "$WORK" && ENVIO_RPC_URL="http://127.0.0.1:1" node_modules/.bin/envio stop)
  note "indexer stopped: containers and database removed"
  exit 0
fi
[ -f "$DEP" ] || die "no deployments file $DEP"

STARTS=()
for n in $(jq -r '.factories | keys[]' "$DEP"); do
  IXF="$(jq -r ".factories.$n.index" "$DEP" | tr 'A-F' 'a-f')"
  # the current records first, then demoHistory: a demo factory can still point at an index a later start moved there
  B="$(jq -r --arg ix "$IXF" '[.production, .demo, (.demoHistory // [])[]] | map(select(. != null and ((.index // "") | ascii_downcase) == $ix)) | .[0].deployBlock // empty' "$REC")"
  [ -n "$B" ] && STARTS+=(--index-start "$n=$B")
done
[ "${#STARTS[@]}" -gt 0 ] || die "no factory's index is in $REC: no --index-start to give"

show "copy indexer/ into $WORK (node_modules linked)"
show "(cd $WORK && bun run scripts/gen-config.ts $DEP --rpc $(cmdline "${STARTS[@]}") --out config.yaml)"
show "ENVIO_RPC_URL=<first http(s) URL printed by AGATE_RPC_URLS_CMD> envio dev [-r when config.yaml changed]"
[ "$KIT_DRY" = 1 ] && exit 0

docker_host
docker info >/dev/null 2>&1 || {
  echo "the indexer needs Docker or Podman for Postgres and Hasura: start it (podman machine start) and reopen this window" >&2
  exit 64
}
mkdir -p "$WORK"
for p in abis src scripts schema.graphql package.json tsconfig.json envio-env.d.ts; do
  rm -rf "${WORK:?}/$p"
  cp -R "$INDEXER/$p" "$WORK/$p"
done
[ -e "$WORK/node_modules" ] || ln -s "$INDEXER/node_modules" "$WORK/node_modules"
(cd "$WORK" && bun run scripts/gen-config.ts "$DEP" --rpc "${STARTS[@]}" --out config.yaml)
SUM="$(shasum -a 256 "$WORK/config.yaml" "$WORK/src/lib/deployments.generated.ts" | shasum -a 256 | cut -c1-16)"
RESTART=""
if [ "$(cat "$WORK/.config-sum" 2>/dev/null || true)" != "$SUM" ]; then RESTART="-r"; fi
[ -n "${AGATE_RPC_URLS_CMD:-}" ] || die "set AGATE_RPC_URLS_CMD"
URL="$(/bin/sh -c "$AGATE_RPC_URLS_CMD" | tr ',' '\n' | grep -E '^https?://' | head -1)" || true
unset AGATE_RPC_URLS_CMD
[ -n "$URL" ] || die "AGATE_RPC_URLS_CMD printed no http(s) URL"
echo "$SUM" >"$WORK/.config-sum"
cd "$WORK"
echo "envio dev ${RESTART:-(resuming)} in $WORK; GraphQL at http://localhost:8080/v1/graphql"
ENVIO_RPC_URL="$URL" exec node_modules/.bin/envio dev $RESTART
