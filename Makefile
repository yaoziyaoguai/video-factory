.DEFAULT_GOAL := help

DB ?= data/video_factory.sqlite
WORKSPACE ?= workspace

.PHONY: help test typecheck studio-local setup-local-trends local-trends-status local-trends-stop

help:
	@echo "Frame: make studio-local (PC 工作台) | make test | make typecheck | make setup-local-trends"

test:
	npm test

typecheck:
	npm run typecheck

studio-local:
	npm run studio:build
	STUDIO_DEV=1 STUDIO_HOST=127.0.0.1 STUDIO_PORT=$${STUDIO_PORT:-4478} npm run studio:start

setup-local-trends:
	bash scripts/local-trends.sh start

local-trends-status:
	bash scripts/local-trends.sh status

local-trends-stop:
	bash scripts/local-trends.sh stop
