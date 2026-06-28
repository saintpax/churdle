# churdle
A clone of "Wordle" for my wife and I to play a single round in evening.

## Golf Rangefinder
`rangefinder.html` is a lightweight, single-file GPS golf rangefinder — no app, no build step, no map tiles or API keys. Walk to the flag (or a hazard, layup spot, anything), tap **Mark Target Here**, then walk back to your ball — the distance updates live using your phone's GPS, with an optional compass arrow pointing toward the target.

Geolocation only works on a secure page, so serve this over `https://` (e.g. GitHub Pages) or open it on `localhost` — phone browsers won't grant GPS access over plain `http://`.
