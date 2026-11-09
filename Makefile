.POSIX:
.PHONY: all help dev start test bench docker docker-up clean

SHELL = /bin/sh
NODE ?= node
BUN  ?= bun
PORT ?= 3000
HOST ?= 0.0.0.0

all: test

help:
	@printf "ShareDrop — High-Performance P2P WebRTC Transfer Engine\n\n"
	@printf "Targets:\n"
	@printf "  make dev         Start hot-reloading development server\n"
	@printf "  make start       Start production server on %s:%s\n" "$(HOST)" "$(PORT)"
	@printf "  make test        Execute automated unit & integration test suite\n"
	@printf "  make bench       Run memory-bounded streaming throughput benchmark\n"
	@printf "  make docker      Build minimal production container image\n"
	@printf "  make docker-up   Launch production stack via docker-compose\n"
	@printf "  make clean       Purge ephemeral uploads and transient state\n"

dev:
	@if command -v $(BUN) >/dev/null 2>&1; then \
		$(BUN) --watch src/server/index.js; \
	else \
		$(NODE) src/server/index.js; \
	fi

start:
	PORT=$(PORT) HOST=$(HOST) NODE_ENV=production $(NODE) src/server/index.js

test:
	@if command -v $(BUN) >/dev/null 2>&1; then \
		$(BUN) test; \
	else \
		$(NODE) --test tests/*.test.js; \
	fi

bench:
	$(NODE) benchmarks/throughput.js

docker:
	docker build -t sharedrop:latest .

docker-up:
	docker-compose up -d --build

clean:
	rm -rf uploads/*.tmp uploads/*-*-*-*-* .nyc_output coverage
	@printf "Purged ephemeral drops and transient runtime state.\n"
