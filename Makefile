.PHONY: build test clean package

build:
	npm run build

test:
	npm test

clean:
	rm -rf dist lib node_modules

package: build
	tar -czf ir-cache-cache-v1.tar.gz action.yml save/ restore/ dist/

install:
	npm ci
