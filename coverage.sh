#!/bin/bash
# Code coverage script for Runotepad
#
# This script generates code coverage reports using cargo-llvm-cov.
# Requirements:
#   - cargo-llvm-cov: cargo install cargo-llvm-cov
#   - llvm-tools-preview: rustup component add llvm-tools-preview
#
# Usage:
#   ./coverage.sh [html|lcov|text]
#
# Output formats:
#   html  - Generate HTML report in target/llvm-cov/html/
#   lcov  - Generate LCOV file at lcov.info
#   text  - Print coverage summary to stdout (default)

set -e

FORMAT=${1:-text}

echo "Running tests with coverage..."

case "$FORMAT" in
    html)
        cargo llvm-cov --all-features --workspace --html
        echo "HTML report generated at: target/llvm-cov/html/index.html"
        ;;
    lcov)
        cargo llvm-cov --all-features --workspace --lcov --output-path lcov.info
        echo "LCOV file generated at: lcov.info"
        ;;
    text)
        cargo llvm-cov --all-features --workspace
        ;;
    *)
        echo "Unknown format: $FORMAT"
        echo "Usage: $0 [html|lcov|text]"
        exit 1
        ;;
esac

echo ""
echo "Coverage report complete!"
