# Builds the "tippecanoe-local" image used by the geo ETL scripts.
# tippecanoe (felt fork) writes PMTiles directly. No public image is reliably
# pullable without auth, so we build from source once.
#
#   docker build -t tippecanoe-local -f scripts/geo/tippecanoe.Dockerfile scripts/geo
#
FROM ubuntu:22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
    git build-essential libsqlite3-dev zlib1g-dev && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 https://github.com/felt/tippecanoe.git /src \
    && cd /src && make -j4 && make install
WORKDIR /data
