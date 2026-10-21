# Replication: what is guaranteed, what is not

"Make it 100% replicable" is achievable for the configuration layer and impossible for the
credentials, the host, and the model. This file draws the line precisely so nobody debugs a
missing key as if it were a broken profile.

## Guaranteed by the installer

- The harness version: `0.2.1-alpha.1`, checked and installed by `bootstrap.sh`. A different
  version is a different platform; the patch layer may compose differently.
- The profile tree: same bundles, same order, same patch layer, same local modules.
- The pinned browser server: `@playwright/mcp@0.0.83`, the version the agent's element refs are
  written against.
- Paths: every `@TOKEN@` in the repo is rewritten against `DSH_HOME`, the resolved node binary,
  the cache dir, and the installed plugin dir. `doctor.sh` fails if a token survived.
- The hook contract: `hooks.json` points at the installed `stop-gate.sh`, executable, with the
  two-block ceiling.

## Not guaranteed, by design

- Credentials and provider accounts. `~/.dsh/.env`, `~/.dsh/.credentials.yaml`, and any OAuth
  login stay yours. The repo contains no key material.
- Sessions, browser profiles, caches, and `~/.dsh` state outside the profile directory.
- Skills and memory files that reflect a person. `skills/briefing` is included as a contract
  example, not as your identity.
- The host: Chrome/Chromium presence, fonts, display server, GPU, Wayland vs X11. `doctor.sh`
  warns about the browser and nothing about display depth.
- Model behaviour. Same prompt, same harness, different serving stack is a different model.

## Determinism levers you can pull

1. Commit `profiles/web/pnpm-lock.yaml` (generated on first `pnpm install`) and install with
   `pnpm install --frozen-lockfile` in CI or on a second machine.
2. Pin `DSH_VERSION` and `@playwright/mcp` explicitly; both are already pinned in the repo.
3. Keep durable instructions in `AGENTS.md` and the profile patch, not in a session summary.
4. Run `./doctor.sh` after every harness upgrade. It composes the profile and lists the rows.

## Upgrade path

```bash
# bump the harness
DSH_VERSION=0.3.0 ./bootstrap.sh          # FORCE=1 if the profile already exists
# bump the browser server
#   edit plugins/playwright-browser/package.json dependency, then
( cd ~/.dsh/profiles/web && pnpm install )
./doctor.sh
```

If the composed profile changes shape, diff `dsh --profile web --dump-config` before and after.

## Portability notes

- Linux and macOS are the supported installs. Windows works through WSL; the hook and the
  bootstrap script assume a POSIX shell.
- The browser stack needs a system Chrome (`--browser chrome`). `WITH_PLAYWRIGHT=1 ./bootstrap.sh`
  also downloads the Chromium build, which is the fallback when no system Chrome exists.
- `DSH_HOME` is honoured everywhere: profile install, doctor, hook path, browser launcher.
