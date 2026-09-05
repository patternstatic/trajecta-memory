# Try Trajecta

This evaluation demonstrates a local handoff that rejects stale work and resumes current work once. It requires an Apple Silicon Mac, Node 22.19–22.x, npm, and Git.

## 1. Check your download

Compare the ZIP SHA-256 and seller key fingerprint with the separate values supplied alongside your download. Keep those values outside this folder. An included key alone does not establish who sent the archive.

## 2. Install in a new test folder

In Terminal, open the unpacked bundle folder. Copy its absolute path before continuing. Create a new empty test folder and run:

```sh
npm install --prefix . --offline --ignore-scripts --package-lock=false --no-audit --no-fund "/absolute/path/to/bundle/packages/trajecta-beta-0.1.0.tgz"
./node_modules/.bin/trajecta-beta version
./node_modules/.bin/trajecta-beta demo --state-root ./demo-state
```

Replace the archive path with your downloaded file. A successful demo prints STALE (revision 3 → 3), CURRENT (3 → 4), then RETRY with the same receipt and revision 4. This is an internal example, not your own project work. Use a new state directory for each demo.

## 3. Run the installed acceptance check

Use the original downloaded ZIP, the separately unpacked bundle, and the SHA-256 pin and public key you obtained independently. Run the installed package from outside a source checkout. Both output paths must be fresh absolute paths whose parent folders already exist. Do not create the state or evidence directories themselves; the command refuses pre-existing output directories.

```sh
/absolute/path/to/test/node_modules/.bin/trajecta-beta verify-acceptance \
  --archive /absolute/path/to/original-download.zip \
  --pinned-zip-sha256 <independent64hex> \
  --bundle-root /absolute/path/to/unpacked/trajecta-verified-resume-sdk-beta-0.1.0 \
  --public-key /absolute/path/to/independent-public.pem \
  --state-root /absolute/path/to/new-acceptance-state \
  --evidence-dir /absolute/path/to/new-acceptance-evidence
```

A successful run prints `ACCEPTANCE_PASSED` and the evidence file path after all 14 automated behavioral checks pass. Acceptance item #15 remains an independent operator observation; the command does not simulate it. This evaluation result is not commercial approval and does not activate a sale.

## 4. Check your own Git workspace

From a local Git workspace with at least one commit, an attached branch and an `origin` remote, invoke the installed binary using its absolute path:

```sh
/absolute/path/to/test/node_modules/.bin/trajecta-beta doctor
/absolute/path/to/test/node_modules/.bin/trajecta-beta host init --out target.json
```

The target card expires after 30 minutes and is single-use. Keep it private. Read the recipes before creating or accepting a handoff.

## What to report

Tell us which step stopped, the displayed error code, and what you expected. Do not send target cards, private work files, access tokens or your entire workspace.

This is a Customer-0 evaluation build. Commercial checkout is inactive. Automated account integration and remote task execution are not included.
