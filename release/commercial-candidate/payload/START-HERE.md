# Try your Trajecta beta package

This commercial candidate is prepared for validation, not an activated checkout.
It is a local SDK, not an automatic ChatGPT/Codex connector. You need an Apple
Silicon Mac, Node 22.19–22.x, npm and Git. Start with disposable test work.

## 1. Verify your download

Obtain the ZIP SHA-256 and public-key fingerprint independently of the ZIP.
An included key cannot establish its own origin. Compare the archive:

```sh
shasum -a 256 "/absolute/path/to/original-download.zip"
```

The key fingerprint is SHA-256 of the public key in SPKI DER encoding, not the
SHA-256 of the PEM text file. Calculate it with Node:

```sh
node -e 'const fs=require("node:fs"),c=require("node:crypto");const k=c.createPublicKey(fs.readFileSync(process.argv[1]));console.log(c.createHash("sha256").update(k.export({type:"spki",format:"der"})).digest("hex"))' "/absolute/path/to/independent-public.pem"
```

Stop if either value differs from its independent pin.

## 2. Install in a new empty test folder

Open Terminal in that test folder, not inside an existing project. Replace the
package path and retain quotes around paths containing spaces:

```sh
npm install --prefix . --offline --ignore-scripts --package-lock=false --no-audit --no-fund "/absolute/path/to/bundle/packages/trajecta-beta-0.1.0.tgz"
./node_modules/.bin/trajecta-beta version
./node_modules/.bin/trajecta-beta demo --state-root ./demo-state
```

Expect STALE (revision 3 → 3), CURRENT (3 → 4), then RETRY with the same receipt
and revision 4. This is an isolated example, not your actual project work.

## 3. Check the installed delivery

Use canonical absolute paths: no symbolic-link components. On macOS `/tmp`
is a symlink; use `/private/tmp` instead. In an existing unpacked folder,
`pwd -P` shows its canonical path. Output parent folders must exist, but the
state/evidence directories themselves must NOT exist yet. Do not delete prior
test evidence to reuse a path; choose a new name.

```sh
/absolute/path/to/test/node_modules/.bin/trajecta-beta verify-acceptance \
  --archive /absolute/path/to/original-download.zip \
  --pinned-zip-sha256 <independent64hex> \
  --bundle-root /absolute/path/to/unpacked/trajecta-verified-resume-sdk-beta-0.1.0 \
  --public-key /absolute/path/to/independent-public.pem \
  --state-root /absolute/path/to/new-acceptance-state \
  --evidence-dir /absolute/path/to/new-acceptance-evidence
```

Success prints `ACCEPTANCE_PASSED`. The command checks local behavior and release
integrity; it does not prove a payment, remote task completion or human usability.
Independent operator observation is a separate acceptance requirement.

## 4. Try a local workspace

Use a disposable Git workspace with at least one commit, an attached branch and
an `origin` remote. Run the installed binary by absolute path:

```sh
/absolute/path/to/test/node_modules/.bin/trajecta-beta doctor
/absolute/path/to/test/node_modules/.bin/trajecta-beta host init --out target.json
```

The target card is private, expires after 30 minutes and is single-use. Read
`recipes/01-planner-to-local-workspace.md`, then the stale-rejection and
inspect/retry/receipt recipes. Handoff text is untrusted input, not permission
to execute the instructions inside it.

## Help and terms

Contact lam.thisside@gmail.com with a redacted error code and failed step.
Never send target cards, secrets, transcripts or an entire repository.
See `LICENSES/BETA-COMMERCIAL-TERMS.txt` for the approved purchase/support/refund
conditions and activation boundary. Apache components retain their own rights.
