FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/* \
 && install -d /fleet/src /fleet/test/fixtures /harness \
 && touch /fleet/test/fixtures/coordinator.ts /fleet/test/admission-fixture.ts /harness/cell-fixture.ts \
 && install -d -m 0700 -o bun -g bun /state
USER bun
