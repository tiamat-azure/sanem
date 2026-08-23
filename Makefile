.DEFAULT_GOAL := help

.PHONY: help start stop restart status logs build test lint funnel-start funnel-stop funnel-status

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

funnel-start: ## Expose the local service on the public internet via Tailscale Funnel
	tailscale funnel --bg --https=10000 3900

funnel-stop: ## Stop the Tailscale Funnel exposure
	tailscale funnel --https=10000 off

funnel-status: ## Show current Tailscale Funnel/Serve configuration
	tailscale funnel status
