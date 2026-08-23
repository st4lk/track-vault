.PHONY: install build-prod build-local serve clean

PYTHON ?= python3

# the site calls install before building; nothing to install here
install:
	@true

build-prod:
	@$(PYTHON) build.py --mode prod --out dist

# local preview: a plain tracks.js is placed next to the page
build-local:
	@$(PYTHON) build.py --mode local --full --out dist --data-file $(DATA)

serve: build-prod
	@cd dist && $(PYTHON) -m http.server 8080

clean:
	@rm -rf dist
