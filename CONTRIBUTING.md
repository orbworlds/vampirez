# Contributing to VampireZ

This repository is where VampireZ is made, and pull requests are welcome: bug fixes, balance, new
maps and modes, things for phones. Merged here, a change is live on [Orb](https://orbworlds.com/orb/vampirez?utm_source=github&utm_medium=readme&utm_campaign=vampirez) for
everyone within about a quarter of an hour.

- **Try it first.** `npm start` runs the game at http://127.0.0.1:4242 with Orb's runtime; open a
  second tab (or press **+ Player**) to test multiplayer. Check phones too: the game plays by touch,
  and your browser's device mode is a good start.
- **Test it.** `npm install` once, then `npm test` plays the whole game in a headless browser
  through its `?debug` hooks (`npm run test:quick` for a shorter run). Every pull request runs it
  too. Something new deserves a check in `test/play.mjs`.
- **One file.** The game is `index.html`. Keep it that way: no build step, no new dependencies
  (libraries come from a CDN at a pinned version, like three.js).
- **Guard `window.orb`.** It only exists on Orb and in the kit: `orb?.store`, never `orb.store`
  alone, so the file still runs on its own.
- **Fair play.** Things in the wardrobe (`orb.shop`) are looks and fun extras, never an advantage.
  Please keep it that way, and keep prices and the shop list as they are unless an issue agreed otherwise.
- **Orb's files.** `orb-kit/`, `test/pw.mjs`, `package.json`, `docs/cover.webp` and
  `.github/workflows/test.yml` come from Orb and are updated by Orb's bot: suggest changes in an issue.

Don't want to write code? [Remix it on Orb](https://orbworlds.com/orb/vampirez?remix&utm_source=github&utm_medium=readme&utm_campaign=vampirez) and describe your change
instead; if it's great, open an issue with the link.
