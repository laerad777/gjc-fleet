#!/usr/bin/env bash
set -euo pipefail
die() { printf 'Fleet cell acceptance FAILED: %s\n' "$*" >&2; exit 1; }
[[ $(uname -s) == Linux ]] || die 'this fixture requires Linux'
command -v docker >/dev/null || die 'Docker CLI missing'
command -v timeout >/dev/null || die 'timeout command missing'
docker --context default compose version >/dev/null || die 'Docker Compose missing'
: "${FLEET_FIXTURE_REPO:?point at isolated Fleet fixture source at 6c01cb7}"
: "${FLEET_CELL_IMAGE:?prebuilt test-only image from image/Dockerfile required}"
[[ -z ${DOCKER_HOST:-} && -z ${DOCKER_CONTEXT:-} ]] || die 'remote Docker contexts are not supported'
host=$(docker context inspect default --format '{{.Endpoints.docker.Host}}')
[[ $host == unix:///* && -S ${host#unix://} ]] || die 'need a local Unix-socket Docker daemon'
export FLEET_FIXTURE_REPO=$(cd -- "$FLEET_FIXTURE_REPO" && pwd -P)
export FLEET_CELL_HARNESS_DIR=$(cd -- "$(dirname -- "$0")" && pwd -P)
# Random project suffix; never target a pre-existing Compose project or volume by user-supplied name.
fixture_id=$(mktemp -d)
project="fleet-fixture-$(basename "$fixture_id" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
compose() {
  timeout --kill-after=5 40 docker --context default compose --project-name "$project" --env-file /dev/null \
    --file "$FLEET_CELL_HARNESS_DIR/compose.yaml" "$@"
}
dkr() { timeout --kill-after=5 25 docker --context default "$@"; }
created=false
cleanup() {
  local code=$?
  trap - EXIT
  if $created; then
    if (( code != 0 )); then compose logs --no-color a b >&2 || true; fi
    if ! compose down --volumes --remove-orphans --timeout 2 >&2; then
      printf 'Fixture teardown failed: %s\n' "$project" >&2
      code=1
    fi
  fi
  rmdir "$fixture_id" || code=1
  if (( code == 0 )); then
    printf '%s\n' 'Fleet cell acceptance PASS: A killed; B durably verified once; A recovered without replay.'
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
dkr image inspect "$FLEET_CELL_IMAGE" >/dev/null || die 'prebuilt fixture image is unavailable; automatic pulls are forbidden'
[[ -z $(dkr ps -a --filter "label=com.docker.compose.project=$project" -q) ]] || die 'project-name collision'
[[ -z $(dkr volume ls --filter "label=com.docker.compose.project=$project" -q) ]] || die 'volume-name collision'
[[ -z $(dkr network ls --filter "label=com.docker.compose.project=$project" -q) ]] || die 'network-name collision'
compose config --quiet
created=true
compose up -d --pull never --no-build a b
a=$(compose ps -aq a)
b=$(compose ps -aq b)
[[ $a =~ ^[0-9a-f]{12,64}$ && $b =~ ^[0-9a-f]{12,64}$ && $a != "$b" ]] || die 'isolated containers required'
network() { dkr inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$1"; }
data() { dkr inspect --format '{{range .Mounts}}{{if and (eq .Destination "/state") (eq .Type "volume")}}{{.Name}}{{end}}{{end}}' "$1"; }
[[ $(network "$a") == "${project}_a " && $(network "$b") == "${project}_b " ]] || die 'cell bridges must be distinct and exclusive'
for net in "${project}_a" "${project}_b"; do
  [[ $(dkr network inspect --format '{{.Internal}}' "$net") == true ]] || die 'cell bridge not internal'
done
[[ $(data "$a") == "${project}_a" && $(data "$b") == "${project}_b" ]] || die 'cell state volumes must be distinct'
[[ $(dkr inspect --format '{{.State.Running}}' "$a") == true && $(dkr inspect --format '{{.State.Running}}' "$b") == true ]] || die 'cells never started'
ready=false
for _ in {1..80}; do
  if [[ $(compose exec -T a bun /harness/cell-fixture.ts ready-a a 2>/dev/null) == READY-A-PID1 ]] &&
     compose exec -T b test -f /state/meta.json; then
    ready=true
    break
  fi
  sleep 0.25
done
$ready || die 'fixture preflight not ready'
compose kill --signal SIGKILL a
state_a() { dkr inspect --format '{{.State.ExitCode}}/{{.State.Running}}' "$a"; }
[[ $(state_a) == 137/false ]] || die 'A was not SIGKILLed'
if compose exec -T a test -r /state/database-path >/dev/null 2>&1; then die 'A can still service requests'; fi
[[ $(compose exec -T b bun /harness/cell-fixture.ts verify-b b) == VERIFIED-B-ONE-EFFECT ]] || die 'B durable verify marker absent'
[[ $(state_a) == 137/false ]] || die 'A recovered before B completed'
# Recover A's original volume in a one-off fresh process, while bypassing its init-only entry point.
[[ $(compose run --rm -T --no-deps --pull never --entrypoint bun a /harness/cell-fixture.ts retry-a a) == RECOVERED-A-NO-REPLAY ]] ||
  die 'A no-replay marker absent'
