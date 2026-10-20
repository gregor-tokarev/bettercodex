<p align="center">
  <img src="build/icon.png" width="128" alt="BetterCodex icon">
</p>

<h1 align="center">BetterCodex</h1>

<p align="center">A Codex desktop app for macOS and Linux whose browser lives on the machine your threads run on.</p>

Work with Codex threads on your laptop or on any machine you reach over SSH. Each machine keeps its own browser, so
the sign-ins and open tabs Codex uses are the ones on that machine, and every window you open shows the same tabs.
Codex can read and drive those tabs freely, and you can click and type in them right next to the chat.

No ChatGPT account screens and no usage dashboards: threads, models, reasoning levels, approvals and the browser.

## Download

Get the latest build from [Releases](https://github.com/gregor-tokarev/bettercodex/releases/latest): the `.dmg` for
Apple silicon Macs, the `.AppImage` or `.deb` for Linux. You need the [Codex CLI](https://github.com/openai/codex)
installed and signed in.

The Mac app isn't notarized yet. After moving it to Applications, run this once so macOS lets it open:

```sh
xattr -dr com.apple.quarantine /Applications/BetterCodex.app
```

## Build from source

Install Node.js 20+ and the [Codex CLI](https://github.com/openai/codex). Machines you add over SSH need Node.js 20+
and the Codex CLI too.

```sh
git clone https://github.com/gregor-tokarev/bettercodex.git
cd bettercodex
npm install
npm start
```

`npm run dist:mac` and `npm run dist:linux` build installable apps.

## License

[MIT](LICENSE)
