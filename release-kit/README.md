# Chrome Web Store release kit

The release machinery of this repository's extension, made reusable for
any Chrome extension: every push to the default branch builds the store
zip, keeps it as a GitHub release, and sends it to the Chrome Web Store
when a repository variable says so. Nothing in it knows this extension;
a new repository uses it with one pasted workflow file, five secrets,
one variable, and one setting made once in this repository.

What a push to `main` does, once set up:

1. runs the extension's tests (the `test` command, if given);
2. builds the zip: an extension with no build step is zipped by the kit's
   own packager (the folder Chrome loads unpacked, without the manifest's
   `key` and without the repository's own tooling, listed under By hand,
   the scripts minified with one pinned esbuild); an extension with a
   build step names its own `build` command and the zip it writes;
3. numbers the build `<manifest version>.<commit count>`, written into the
   zip's manifest, so every build from `main` is above the last one
   without a commit that only raises the manifest (the manifest keeps
   three integers; the fourth is the build number);
4. makes the GitHub release `extension-v<that version>`, the repository's
   latest, with the zip and its SHA-256 attached under the versioned name
   `<name>-<version>-chrome.zip` and under the fixed name
   `<name>-chrome.zip`, so the newest build is always at
   `https://github.com/<owner>/<repo>/releases/latest/download/<name>-chrome.zip`;
5. uploads that same zip to the store item as its draft when the
   repository variable `CWS_ON_PUSH` is `upload`, and submits the draft
   for review as well when it is `publish`; unset or `off`, the release
   is made and nothing goes to the store.

A tag `extension-v<version>` releases the manifest's exact version the
same way and always uploads it. **Run workflow** in Actions, with
`upload` and/or `publish` ticked, does it by hand on any branch or tag;
with neither ticked it tests and builds and keeps the zip as the run's
artifact. Without the five secrets the store step says "Not configured"
and the run stays green, so the kit can go in before the store item
exists.

## Using it in a new repository

### 1. The workflow file

Copy [`caller.yml`](caller.yml) to `.github/workflows/release.yml` in the
new repository. Before its first push, step 3 below must have been done
once, in this repository, or the run stops at once with the kit's
workflow not found. The file is this:

```yaml
name: Release the extension

# The Chrome Web Store release kit (OpenSpineConsortium/claude-swap-cloud,
# release-kit/README.md): every push to main builds the store zip as
# version <manifest>.<commit count> and keeps it as a GitHub release; the
# repository variable CWS_ON_PUSH (upload or publish) sends that zip on to
# the store through the five CWS_ secrets. A tag extension-v<version>
# releases that exact version and always uploads it. Run workflow with
# upload and/or publish ticked does it by hand. The kit itself is taken
# from that repository at main on every run, so a fix there reaches this
# repository's next release with no change here.

on:
  push:
    branches: [main]
    tags: ['extension-v*']
  workflow_dispatch:
    inputs:
      upload:
        description: 'Upload the zip to the Chrome Web Store item (needs the CWS_ secrets)'
        type: boolean
        default: false
      publish:
        description: 'Submit the draft for review (it goes out on approval with the visibility the item has in the dashboard)'
        type: boolean
        default: false

# The release needs to write; one release at a time, in the order they
# started, so a lower build never follows a higher one to the store.
permissions:
  contents: write

concurrency:
  group: chrome-web-store
  cancel-in-progress: false

jobs:
  release:
    uses: OpenSpineConsortium/claude-swap-cloud/.github/workflows/release-kit.yml@main
    with:
      # The folder Chrome loads unpacked; the kit's packager zips it. An
      # extension with a build step of its own names the command and the
      # zip it writes instead:
      #   build: cd extension && npm ci && npm run zip
      #   zip: extension/.output/*-chrome.zip
      dir: extension
      on-push: ${{ vars.CWS_ON_PUSH }}
      upload: ${{ inputs.upload == true }}
      publish: ${{ inputs.publish == true }}
    # The five store secrets by name, and nothing else of this repository's.
    secrets:
      CWS_PUBLISHER_ID: ${{ secrets.CWS_PUBLISHER_ID }}
      CWS_ITEM_ID: ${{ secrets.CWS_ITEM_ID }}
      CWS_CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}
      CWS_CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}
      CWS_REFRESH_TOKEN: ${{ secrets.CWS_REFRESH_TOKEN }}
```

Change `dir` if the extension's folder is not `extension/`, or give
`build` and `zip` for an extension with a build step (below). Add a
`paths:` filter under `push` to release only when the extension changed,
as this repository's `release.yml` does, or leave it out to release every
push. The default branch is `main` here; name yours.

### 2. The secrets and the variable

In the new repository, **Settings, Secrets and variables, Actions**:

| Where | Name | What |
| --- | --- | --- |
| Secrets | `CWS_PUBLISHER_ID` | The publisher id, under **Publisher, Settings** in the developer dashboard. |
| Secrets | `CWS_ITEM_ID` | The item's id: 32 letters a to p, in the dashboard and the item's URL. The first upload is by hand; it gives the item its id. |
| Secrets | `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` | An OAuth client of the Google account that owns the item (below). |
| Secrets | `CWS_REFRESH_TOKEN` | A refresh token for that client, made once (below). |
| Variables | `CWS_ON_PUSH` | `upload`, `publish`, or unset. A variable, not a secret, so the workflow can read it. Leave it unset until the first upload by hand has given the item its id. |

The same OAuth client and refresh token can serve every extension the
same Google account publishes; only `CWS_ITEM_ID` differs between
repositories.

**The OAuth client**, once per Google account, following Google's own
page (https://developer.chrome.com/docs/webstore/using-api, which has the
screenshots): in the Google Cloud console
(https://console.cloud.google.com), with the account that owns the store
item, make a project (any name) and enable the **Chrome Web Store API**
(APIs and services, Library). Set up the OAuth consent screen: External,
your email as the contact and as a test user, and **publish** it
(Publishing status, Publish app): a consent screen left in Testing gives
refresh tokens that expire after seven days. Then APIs and services,
Credentials, **Create credentials, OAuth client ID**, type **Web
application**, with `https://developers.google.com/oauthplayground` among
the authorized redirect URIs. Its client id and client secret are
`CWS_CLIENT_ID` and `CWS_CLIENT_SECRET`.

**The refresh token**, once, from the same account, in the OAuth 2.0
Playground (https://developers.google.com/oauthplayground): the gear
icon, "Use your own OAuth credentials", the client id and secret; under
"Input your own scopes" `https://www.googleapis.com/auth/chromewebstore`;
**Authorize APIs**, allow (Google does not verify apps that hold the
store's write scope, so "Google hasn't verified this app" is expected:
Advanced, then "Go to <name> (unsafe)"); then **Exchange authorization
code for tokens**. The `refresh_token` it shows is `CWS_REFRESH_TOKEN`.

Check without sending: with the five variables in a shell,
`node release-kit/store/publish.mjs --status` reads the item's state, and
`--upload --zip <file> --dry-run` prints the requests it would make.

### 3. Letting the new repository use the kit

The kit lives in this private repository, so once, here: **Settings,
Actions, General**, the **Access** section at the bottom, choose
**Accessible from repositories in the 'OpenSpineConsortium'
organization**, and Save. After that every repository in the organization
can call the workflow and the actions with the lines above; no token is
needed. A repository outside the organization cannot reach a private
repository's workflows at all; for that, move the kit to a public
repository of its own (below).

The kit floats: every run takes it from this repository at `main`, so a
fix to it reaches every caller's next release with no change there. That
is on purpose, one place to fix, and it is why a change to the kit is
tried here first: a pull request in this repository runs the checkout's
own copy of the kit, every other repository runs `main`'s. So who can
write to this repository's `main` is the trust boundary of every caller;
a caller passes the kit its five store secrets by name and nothing else
of its own. A caller that wants a kit that never moves copies it to a
repository of its own (below) and pins what it likes there.

## Extensions with a build step

An extension built by WXT, Vite or another tool makes its own zip; the
kit takes it from there. Give the command and the zip it writes:

```yaml
    with:
      name: my-extension
      setup: cd extension && npm ci
      test: cd extension && npm test
      build: cd extension && npm run zip
      zip: extension/.output/*-chrome.zip
```

Each command runs with bash from the repository root, on the Node the
`node-version` input installs (24 by default). `EXTENSION_BUILD` holds
the build number during them (empty on a tag), for a build that wants to
stamp the version itself: a version whose last integer is already the
build number is left as it is. One that does not is stamped by the kit,
which rewrites only `manifest.json` inside the zip (and drops a `key` if
the build left one in). A zip whose manifest needs no change is released
byte for byte as built. The build's output folder (`.output/` above) is
the build's, not the repository's; list it in `.gitignore`.

This repository is the other shape: its own packager with its own rules
(`extension/scripts/package.mjs`), named as the `build`, and the kit's
stamp gives the same bytes that packager's `--build N` does.

## Every input

| Input | Default | Meaning |
| --- | --- | --- |
| `name` | the manifest's name, lower case, dashes | The file name: `NAME-<version>-chrome.zip` and `NAME-chrome.zip`. A localized name (`__MSG_...__`) is read from the default locale's messages in the zip, for the release's title too. |
| `dir` | `extension` | The folder the kit's packager zips when `build` is empty. |
| `build` | | A command that writes the zip. |
| `zip` | | With `build`: the zip it writes, a path or a pattern with one match. |
| `setup` | | A command before the test and the build. |
| `test` | | A command before the build; a failure stops the release. |
| `extra` | | For the kit's packager: files from outside the folder, one per line, `PATH` or `PATH:NAME` (a `PRIVACY.md` at the repository root). |
| `node-version` | `24` | What the commands and the kit run with; 22.2 or newer. |
| `tag-prefix` | `extension-v` | What a release tag starts with; the release is tagged `PREFIX<version>`. |
| `release` | `true` | Make the GitHub release (on a push, and on a manual run that uploads). |
| `on-push` | | What a push to the default branch does at the store: pass `${{ vars.CWS_ON_PUSH }}`. |
| `upload`, `publish` | `false` | The manual run's boxes. |

The workflow's outputs are `version`, `tag` and `sha256`.

## The two actions, in a workflow of your own

The workflow is two composite actions in a row, usable on their own. The
job needs `permissions: contents: write` for the release, as a new
repository's default token is read-only:

```yaml
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write           # the GitHub release
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # the commit count numbers the build
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - id: kit
        uses: OpenSpineConsortium/claude-swap-cloud/release-kit@main
        with:
          name: my-extension
          dir: extension
          release: ${{ github.event_name == 'push' }}
      - uses: OpenSpineConsortium/claude-swap-cloud/release-kit/store@main
        with:
          zip: ${{ steps.kit.outputs.zip }}
          publisher-id: ${{ secrets.CWS_PUBLISHER_ID }}
          item-id: ${{ secrets.CWS_ITEM_ID }}
          client-id: ${{ secrets.CWS_CLIENT_ID }}
          client-secret: ${{ secrets.CWS_CLIENT_SECRET }}
          refresh-token: ${{ secrets.CWS_REFRESH_TOKEN }}
```

`release-kit` (`action.yml`) takes `name`, `dir`, `build`, `zip`,
`setup`, `test`, `extra` and `tag-prefix` as the table has them, plus
`release` (false there unless passed: the workflow is what turns it on
for a push), `latest`, `token` and `out`, and gives `name`, `version`,
`tag`, `title`, `dir`, `zip`, `zipname`, `fixed`, `fixedname` and
`sha256`; `node-version`, `on-push`, `upload` and `publish` are the
workflow's alone. `release-kit/store` (`store/action.yml`) takes `zip`,
`upload` (default true), `publish`, `staged`, `status` and the five
credentials; a composite action cannot read secrets, so they are passed
in, and only its one step sees them. This repository's `ci.yml` runs
both on every pull request.

## By hand

The three scripts need Node 22.2 or newer and nothing installed:

- `node release-kit/package.mjs --dir extension --out dist` builds the
  zip; `--extra PRIVACY.md` adds a file from outside the folder,
  `--exclude 'docs/**'` leaves more out, `--build N` stamps the version,
  `--plain` skips the minifying, `--check` writes nothing. The minifying
  runs esbuild 0.25.11 through npx, or the binary `RELEASE_KIT_ESBUILD`
  names. The packager leaves out, always: `node_modules/`,
  `store-assets/`, `test/`, `tests/`, `e2e/`, anything whose name starts
  with a dot, `README*`, `package.json`, `package-lock.json`,
  `tsconfig*.json`, `*.test.js` and `*.map`; `--exclude` adds to that
  list and nothing takes from it, so a folder the extension loads must
  not carry one of those names. A file the manifest or a page (a
  script's `src`, a link's `href`, an image's `src`) names and the
  package lacks stops the build with its name.
- `node release-kit/stamp.mjs --zip dist/x.zip --out release --build N`
  (or `--tag extension-v1.2.0`) writes the four release files from any
  zip.
- `node release-kit/store/publish.mjs --status`, `--upload --zip FILE`,
  `--publish [--staged]`, `--dry-run`, with the five `CWS_` variables in
  the environment.

Tests: `node --test "release-kit/tests/*.test.js"`.

## Moving the kit to a repository of its own

The kit is this folder plus `.github/workflows/release-kit.yml` (a
reusable workflow has to live in `.github/workflows/`). To give it a
repository of its own, say `OpenSpineConsortium/chrome-store-release-kit`:

1. copy the folder `release-kit/` as a folder, so that it is
   `<new repository>/release-kit/`, and `.github/workflows/release-kit.yml`
   to the same path there;
2. in the copied `release-kit.yml`, change the four lines that name this
   repository to the new one: the two `uses:` lines
   (`OpenSpineConsortium/claude-swap-cloud/release-kit@main` and
   `OpenSpineConsortium/claude-swap-cloud/release-kit/store@main`) and the two
   `if: github.repository == ...` lines beside them;
3. in `release-kit/caller.yml`, in this README (its copy of `caller.yml`,
   which the tests hold equal, and the two `uses:` lines of the example
   above) and in each caller, change the `uses:` line to
   `OpenSpineConsortium/<new repository>/.github/workflows/release-kit.yml@main`
   (the kit's tests read the repository's name from `caller.yml` and hold
   the workflow's four lines to it);
4. if the new repository is private, set its Actions access (step 3
   above) there; a public one needs no setting and serves any caller.

The kit has no file that names this extension. Four of its files name
this repository (`release-kit.yml`, `caller.yml`, this README and the
tests, which read the name from `caller.yml`), and steps 2 and 3 cover
them; this repository's own `release.yml` is just one caller.

## What it does not do, on purpose

- No obfuscation, no encryption, no source map in the zip: the store's
  code readability policy allows minifying (whitespace, comments and
  local names) and forbids the rest. The kit does nothing per account and
  nothing automatic at the store beyond the upload and the submit.
- No retry: an upload the store refuses ends the run with the store's own
  words (the usual cause is a version not above the published one), and
  the person decides. A package the store is still processing is given
  five minutes to become the draft before a publish, then the run says
  how to publish later.
- No Firefox, Edge or Safari listing; no signed `.crx` (if the item is
  ever opted in to Verified CRX Uploads, the API wants one, which this
  kit does not make; leave that opt-in off).
- No rule about which permissions an extension may ask for: that is each
  repository's own test. The packager checks only what the store or
  Chrome would refuse (the manifest's limits, files the manifest names,
  icon sizes, imports between the scripts).
