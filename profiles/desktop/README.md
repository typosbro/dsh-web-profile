# desktop profile template

A backup of the profile the DSH **Desktop** app owns. The app manages
`~/.dsh/profiles/desktop` itself and the CLI refuses that profile name, so this
directory is a template, not something `bootstrap.sh` installs by default.

- Use `./install-desktop.sh` to merge the portable rows into the running app
  (it writes a marked block into the app's patch layer and can `--uninstall`).
- `WITH_DESKTOP=1 ./bootstrap.sh` copies these files verbatim into
  `~/.dsh/profiles/desktop` — only useful on a machine where the app is not yet
  configured, or for diffing what the app currently has.
- `package.json` links `@local/dsh-web-search-local` back to `../../plugins/web-search`,
  so a restored copy needs `pnpm install` in the profile directory.

The live desktop profile also carries app-managed rows (chat view, onboarding,
account) that are not reproduced here on purpose — the app writes them itself.
