# track-vault

Map viewer for an encrypted data file. The data lives outside this repo; the page
downloads it, asks for a password and decrypts it in the browser. The server never
sees the password and this repo never holds the data.

## Build

```sh
make build-prod          # -> dist/index.html  (fetches the URL from src/config.json)
make serve               # same, plus http://localhost:8080
```

`dist/` is what gets published. Nothing else is needed at runtime except a browser.

## Local preview with a plain file

```sh
make build-local DATA=/path/to/tracks.js
```

Builds a page without the password form that reads `tracks.js` sitting next to it.

## Weather

The cloud button opens a panel with a day and an hour. Each measure has its own
checkbox, so they can be read together: degrees, millimetres and per cent of
water in the soil are printed as numbers over a grid covering the current view,
each with a small mark saying which is which, and wind arrows sit above them
showing steady…gust speed, coloured by the gusts - out in the open it is the
gusts that are felt.

A picked route is painted green where the wind pushes and red where it pushes
back. "Ride it back" flips the direction, since the same road is a different ride
depending on which end you start from.

Data comes from [Open-Meteo](https://open-meteo.com/) - no key, CORS open, so the
page asks for it directly, a week ahead.

Their free tier is measured in locations times variables times days rather than
in requests, so the grid is snapped to a fixed lattice and every cell is kept:
panning lands on cells already in hand and asks for nothing. Only cells never
seen before are fetched, and only once the map has stopped moving. On HTTP 429
the panel says so and waits a minute.

## On a phone

Both the weather panel and the track card become sheets pinned to the bottom
edge, so the map stays visible above them. The card folds to its title with the
arrow next to the close cross, and folding it keeps the track selected. Hiding
the weather panel leaves the layers running - only the checkboxes switch them
off. When both would sit at the bottom at once, the card is lifted above the
panel and the newcomer gets the room.

## Configuration

`src/config.json`:

* `data_url` — where the encrypted file is downloaded from. Must be served with a
  permissive CORS header; a Dropbox share link works if the host is
  `dl.dropboxusercontent.com` (`www.dropbox.com` does not).
* `title` — page title.

## Updating the data

Data is produced elsewhere. The routine is:

```sh
make update                                  # in the data repo: refresh + rebuild
make encrypt URL="<link to the file>"        # -> dist/velo.enc
```

then upload the resulting file to the same place. If the link changed, update
`data_url` here and rebuild.

## Layout

```
src/template.html   page skeleton
src/markup.html     app markup
src/app.css         styles, all scoped under #tv so the page can be embedded
src/app.js          the map itself, expects window.VELO_DATA
src/gate.html/.js   password form, download, decryption (PBKDF2 + AES-GCM)
src/weather.js      weather overlays and the head/tail wind painting
build.py            assembles everything into a single self-contained file
```
