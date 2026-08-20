PYTHON ?= python3
DB ?= data/video_factory.sqlite
WORKSPACE ?= workspace
RUN = PYTHONPATH=src $(PYTHON) -m video_factory

.PHONY: init demo test

init:
	$(RUN) --db $(DB) init

demo:
	$(RUN) --db $(DB) --workspace $(WORKSPACE) demo

test:
	PYTHONPATH=src $(PYTHON) -m unittest discover -s tests
