# track-vault

The map page for an encrypted data file. Data lives outside this repo: the page
downloads it, asks for a password and decrypts it in the browser.

## Build

```sh
make build-prod    # -> dist/index.html, the thing that gets published
make serve         # same, plus http://localhost:8080
```

The site pulls this repo as a submodule and runs `make build-prod` itself, so
usually there is nothing to do here beyond pushing.

## Point it at another file

`data_url` in `src/config.json`. A Dropbox link works only with the
`dl.dropboxusercontent.com` host, not `www.dropbox.com`.

## Preview with a plain file

```sh
make build-local DATA=/path/to/tracks.js
```

Details, if ever needed: [NOTES.md](NOTES.md).
