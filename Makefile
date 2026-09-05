#
# Task runners for this project's development lifecycle.
#

.PHONY: install startup log lint fix typecheck test check help

help:
	@echo "Available targets:"
	@echo "  install    - Install this project centrally and put `genie` on PATH"
	@echo "  startup    - Open an interactive agent session, from this working tree"
	@echo "  log        - Tail the audit trail, from this working tree"
	@echo "  lint       - Lint all JavaScript and TypeScript sources with ESLint"
	@echo "  fix        - Auto-fix lint problems with ESLint, then report anything that remains"
	@echo "  typecheck  - Type-check all TypeScript sources with tsc, without emitting output"
	@echo "  test       - Run the test suite with the Node.js built-in test runner"
	@echo "  check      - Run all checks: lint, then type-check, then tests, in sequence"
	@echo "  help       - Show this help message"

install:
	./run/install

startup:
	./run/startup

log:
	./run/log

lint:
	./run/lint

fix:
	./run/fix

typecheck:
	./run/typecheck

test:
	./run/test

check:
	./run/check
