.PHONY: help build test coverage clean run install-dev

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

build: ## Build both frontend and backend
	cd frontend && npm run build
	cargo build

build-release: ## Build release version
	cd frontend && npm run build
	cargo build --release

test: ## Run all tests
	cargo test
	cd e2e && npm test

test-rust: ## Run Rust unit tests only
	cargo test

test-e2e: ## Run E2E tests only
	cd e2e && npm test

coverage: ## Generate code coverage report (HTML)
	./coverage.sh html

coverage-lcov: ## Generate LCOV coverage report
	./coverage.sh lcov

coverage-text: ## Print coverage summary
	./coverage.sh text

clean: ## Clean build artifacts
	cargo clean
	cd frontend && rm -rf node_modules dist
	rm -f lcov.info
	rm -rf target/llvm-cov

run: ## Run the server
	cargo run

run-release: ## Run the release build
	cargo run --release

install-dev: ## Install development dependencies
	cd frontend && npm install
	cargo install cargo-llvm-cov || echo "cargo-llvm-cov installation failed (optional)"

watch-frontend: ## Watch and rebuild frontend
	cd frontend && npm run watch

format: ## Format code
	cargo fmt
	cd frontend && npm run typecheck

lint: ## Run linters
	cargo clippy
	cd frontend && npm run typecheck
