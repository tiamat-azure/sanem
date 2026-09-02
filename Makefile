.DEFAULT_GOAL := help

.PHONY: help start stop restart status logs build test lint thumbs funnel-start funnel-stop funnel-status

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

start: ## Build and start the Sanem container (docker compose up -d --build)
	docker compose up -d --build

stop: ## Stop and remove the Sanem container (docker compose down)
	docker compose down

restart: stop start ## Restart the Sanem container

status: ## Show container status
	docker compose ps

logs: ## Follow container logs (Ctrl+C to stop)
	docker compose logs -f sanem

build: ## Build the Docker image without starting it
	docker compose build

test: ## Run the test suite (unit + resume integration test)
	npm test

lint: ## Run eslint
	npm run lint

thumbs: ## Pre-generate every missing thumbnail (+ probe cache, HLS plans) via the running service API
	@set -eu; \
	[ -f .env ] && { set -a; . ./.env; set +a; } || true; \
	base="http://localhost:$${SANEM_PORT:-3900}"; \
	: "$${SANEM_PASSWORD:?set SANEM_PASSWORD (or provide a .env)}"; \
	jar="$$(mktemp)"; trap 'rm -f "$$jar"' EXIT; \
	echo "[thumbs] logging in to $$base"; \
	code="$$(curl -sS -o /dev/null -w '%{http_code}' -c "$$jar" \
		-H 'Content-Type: application/json' \
		--data "$$(jq -n --arg p "$$SANEM_PASSWORD" '{password:$$p}')" \
		"$$base/api/login" || true)"; \
	[ "$$code" = 204 ] || { echo "[thumbs] login failed (HTTP $$code)"; exit 1; }; \
	echo "[thumbs] triggering analysis, then waiting for thumbnails (timeout 30 min)"; \
	deadline=$$(( $$(date +%s) + 1800 )); \
	while :; do \
		missing=""; \
		for p in $$(curl -sS -b "$$jar" "$$base/api/files" \
			| jq -r '.[] | select(.kind == "video") | .path'); do \
			enc="$$(jq -rn --arg s "$$p" '$$s | split("/") | map(@uri) | join("/")')"; \
			tc="$$(curl -sS -o /dev/null -w '%{http_code}' -b "$$jar" "$$base/api/thumbs/$$enc")"; \
			[ "$$tc" = 200 ] || missing="$$missing  - $$p\n"; \
		done; \
		[ -z "$$missing" ] && { echo "[thumbs] all thumbnails present"; break; }; \
		n="$$(printf '%b' "$$missing" | grep -c . || true)"; \
		[ "$$(date +%s)" -ge "$$deadline" ] && { \
			echo "[thumbs] timed out, $$n still missing:"; printf '%b' "$$missing"; exit 1; }; \
		echo "[thumbs] $$n pending, re-checking in 10 s"; \
		sleep 10; \
	done

funnel-start: ## Expose the local service on the public internet via Tailscale Funnel
	tailscale funnel --bg --https=443 3900

funnel-stop: ## Stop the Tailscale Funnel exposure
	tailscale funnel --https=443 off

funnel-status: ## Show current Tailscale Funnel/Serve configuration
	tailscale funnel status
