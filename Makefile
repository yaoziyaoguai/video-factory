LOCAL_PYTHON := $(CURDIR)/.local/python/.venv/bin/python
PYTHON ?= $(if $(wildcard $(LOCAL_PYTHON)),$(LOCAL_PYTHON),python3)
DB ?= data/video_factory.sqlite
WORKSPACE ?= workspace
CODEX_SOCKET ?= /run/video-factory-codex/worker.sock
RUN = PYTHONPATH=src $(PYTHON) -m video_factory

.PHONY: init demo test test-py test-ts test-e2e typecheck sample-production setup-local-runtime setup-local-trends local-trends-status local-trends-stop codex-broker-build codex-broker-test codex-broker-status

init:
	$(RUN) --db $(DB) init

demo:
	$(RUN) --db $(DB) --workspace $(WORKSPACE) demo

test: test-py test-ts

test-py:
	PYTHONPATH=src $(PYTHON) -m unittest discover -s tests

test-ts:
	npm test

test-e2e:
	command -v ffmpeg >/dev/null
	command -v ffprobe >/dev/null
	command -v say >/dev/null
	VIDEO_FACTORY_PYTHON=$(PYTHON) npm run test:e2e

sample-production:
	npm run factory -- run examples/briefs/life-avoidance-local.json --workspace $(WORKSPACE)/factory

setup-local-runtime:
	bash scripts/setup-local-runtime.sh

setup-local-trends:
	bash scripts/setup-local-trends.sh

local-trends-status:
	bash scripts/local-trends.sh status

local-trends-stop:
	bash scripts/local-trends.sh stop

codex-broker-build:
	npm run build:broker

codex-broker-test:
	npm run test:broker

# 只探测已运行的宿主机 broker，不启动任何服务。
codex-broker-status:
	-curl --fail --silent --show-error --unix-socket $(CODEX_SOCKET) http://localhost/health

typecheck:
	npm run typecheck
