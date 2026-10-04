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

# `envio dev` and `envio stop` manage Docker resources under fixed global names (envio-postgres, envio-hasura,
# envio-network, envio-postgres-data), whatever the project folder. So on a fork, a run beside another indexer (the
# live one, for one) would attach to that indexer's containers and, with -r, reset its database, and the fork's stop
# would remove them. A fork run therefore starts envio only when no such container exists or every one that exists is
# its own, and records in $WORK/.fork-owns-envio the id of each container its envio dev creates, as it appears (so a
# start that failed half-way, with only envio-postgres made, still owns that one and the next start resumes). It stops
# only containers whose ids it recorded: a marker naming containers since removed or replaced (by the live indexer,
# say) is stale and never makes another indexer's containers this run's. Its refusal exits 64, the code up.sh's
# launcher does not restart.
OWNS="$WORK/.fork-owns-envio"
envio_containers() { docker container inspect envio-postgres >/dev/null 2>&1 || docker container inspect envio-hasura >/dev/null 2>&1; }
# the id of each of the two that exists, one per line (nothing when neither does)
envio_ids() { docker container inspect -f '{{.Id}}' envio-postgres envio-hasura 2>/dev/null || true; }
owns_envio() { [ -f "$OWNS" ] && [ "$(cat "$OWNS")" = "$(envio_ids)" ]; }

# stop: the shared-indexer window's Ctrl-C ends `envio dev` but leaves its containers running (a restart resumes from
# them); this removes them, and the database with them (the next run indexes again from the deploy blocks)
if [ "${KIT_POS[0]}" = stop ]; then
  show "(cd $WORK && envio stop)"
  [ "$KIT_DRY" = 1 ] && exit 0
  [ -x "$WORK/node_modules/.bin/envio" ] || { note "no indexer in $WORK: nothing to stop"; exit 0; }
  docker_host
  docker info >/dev/null 2>&1 || { note "no Docker or Podman answers: nothing to stop"; exit 0; }
  if [ "$KIT_FORK" = 1 ] && ! owns_envio; then
    if ! envio_containers; then
      rm -f "$OWNS"
      note "no Envio container: nothing to stop"
      exit 0
    fi
    die "the Envio containers are not this fork run's (no $OWNS naming them): nothing stopped (they may be another indexer's)"
  fi
  # envio reads config.yaml, whose RPC URL is ENVIO_RPC_URL: a placeholder, since stop contacts no chain
  (cd "$WORK" && ENVIO_RPC_URL="http://127.0.0.1:1" node_modules/.bin/envio stop)
  rm -f "$OWNS"
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
if [ "$KIT_FORK" = 1 ] && ! owns_envio; then
  rm -f "$OWNS" # stale: its containers are gone or are not the ones it named
  if envio_containers; then
    echo "stopped: envio-postgres or envio-hasura exists (another indexer, for one the live one on localhost:8080): a fork's envio dev would attach to it and reset its database; stop that indexer first, or rehearse without the indexer" >&2
    exit 64
  fi
fi
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
if [ "$KIT_FORK" = 1 ]; then
  # records each container as this run's envio dev creates it (it runs in this process after the exec): every one
  # that exists now is this run's (checked above), so every one that appears is too. It records once more after envio
  # dev has ended, so a container made just before a failure is never left without an owner.
  MAIN=$$
  (
    for _ in $(seq 1 600); do
      up=1
      kill -0 "$MAIN" 2>/dev/null || up=0
      IDS="$(envio_ids)"
      if [ -n "$IDS" ] && [ "$IDS" != "$(cat "$OWNS" 2>/dev/null || true)" ]; then
        printf '%s\n' "$IDS" >"$OWNS.tmp" && mv "$OWNS.tmp" "$OWNS"
      fi
      [ "$up" = 1 ] || exit 0
      [ "$(printf '%s\n' "$IDS" | grep -c .)" -ge 2 ] && exit 0
      sleep 1
    done
  ) >/dev/null 2>&1 &
fi
echo "envio dev ${RESTART:-(resuming)} in $WORK; GraphQL at http://localhost:8080/v1/graphql"
ENVIO_RPC_URL="$URL" exec node_modules/.bin/envio dev $RESTART
