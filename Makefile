.PHONY: install build-prod build-local serve clean

PYTHON ?= python3

# сайт вызывает install перед сборкой; тут ставить нечего
install:
	@true

build-prod:
	@$(PYTHON) build.py --mode prod --out dist

# локальный просмотр: рядом кладётся незашифрованный tracks.js
build-local:
	@$(PYTHON) build.py --mode local --full --out dist --data-file $(DATA)

serve: build-prod
	@cd dist && $(PYTHON) -m http.server 8080

clean:
	@rm -rf dist
