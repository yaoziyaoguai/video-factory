LOCAL_PYTHON := $(CURDIR)/.local/python/.venv/bin/python
PYTHON ?= $(if $(wildcard $(LOCAL_PYTHON)),$(LOCAL_PYTHON),python3)
DB ?= data/video_factory.sqlite
WORKSPACE ?= workspace
RUN = PYTHONPATH=src $(PYTHON) -m video_factory

.PHONY: init demo test test-py test-ts test-e2e typecheck sample-production setup-local-runtime setup-local-voice setup-local-agent setup-local-trends local-trends-status local-trends-stop

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

setup-local-voice:
	bash scripts/setup-local-voice.sh

setup-local-agent:
	bash scripts/setup-local-agent.sh

setup-local-trends:
	bash scripts/setup-local-trends.sh

local-trends-status:
	bash scripts/local-trends.sh status

local-trends-stop:
	bash scripts/local-trends.sh stop

typecheck:
	npm run typecheck
