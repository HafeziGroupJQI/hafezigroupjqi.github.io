import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { docsManifest } from "../docs-manifest.mjs"
import { vaultFolders } from "../folder-files.mjs"
import { pageHistories } from "../history.mjs"
import {
  applyOverlay,
  checkSupported,
  overlayFiles,
  readVaults,
  restrictedDirs,
  vaultOf,
} from "./vaults.mjs"

const VAULTS = [
  { repo: "vault-private", prefix: "" },
  { repo: "vault-optical-rl", prefix: "projects/optical-rl/" },
]

// A git work tree with these files, committed once.
function repository(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-vault-"))
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Ada Lovelace",
        GIT_AUTHOR_EMAIL: "ada@example.com",
        GIT_COMMITTER_NAME: "c",
        GIT_COMMITTER_EMAIL: "c@example.com",
      },
    })
  git("init", "-q")
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  git("add", "-A")
  git("commit", "-q", "-m", "seed")
  return root
}

test("the vaults are worker/vaults.json's, and a path is its longest prefix's", () => {
  assert.deepEqual(readVaults(), VAULTS)
  assert.equal(vaultOf(VAULTS, "projects/optical-rl/notes/x.md"), "vault-optical-rl")
  assert.equal(vaultOf(VAULTS, "projects/optical-rl"), "vault-private")
  assert.equal(vaultOf(VAULTS, "notes/x.md"), "vault-private")
})

test("VAULT_RESTRICTED_DIRS names restricted vaults' checkouts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-restricted-"))
  try {
    assert.deepEqual(restrictedDirs("", VAULTS), [])
    assert.deepEqual(restrictedDirs(undefined, VAULTS), [])
    assert.deepEqual(restrictedDirs(` vault-optical-rl=${dir} ,`, VAULTS), [
      { repo: "vault-optical-rl", prefix: "projects/optical-rl/", dir: fs.realpathSync(dir) },
    ])
    assert.throws(() => restrictedDirs(`vault-private=${dir}`, VAULTS), /not a restricted vault/)
    assert.throws(() => restrictedDirs(`vault-elsewhere=${dir}`, VAULTS), /not a restricted vault/)
    assert.throws(() => restrictedDirs(dir, VAULTS), /is not repo=dir/)
    assert.throws(
      () => restrictedDirs(`vault-optical-rl=${dir},vault-optical-rl=${dir}`, VAULTS),
      /named twice/,
    )
    assert.throws(
      () => restrictedDirs(`vault-optical-rl=${dir}/missing`, VAULTS),
      /is not a folder/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a restricted vault overlays its folder, and nothing outside it or already there", () => {
  const privateRoot = repository({
    "notes/a.md": "a",
    "projects/index.md": "projects",
    "files/Big Laser/manual.pdf": "%PDF a",
  })
  const dir = repository({
    "README.md": "readme",
    ".github/workflows/validate.yml": "on: push",
    "projects/optical-rl/notes/x.qmd": "x",
    "projects/optical-rl/files/run.py": "print(1)",
    "projects/optical-rl/files/Data Set/raw.csv": "1,2",
    "projects/optical-rl/assets/plot.png": "png",
  })
  const restricted = [{ repo: "vault-optical-rl", prefix: "projects/optical-rl/", dir }]
  const excluded = new Set(["README.md"])
  try {
    const files = overlayFiles(restricted, privateRoot, { excluded })
    assert.deepEqual(
      files.map((file) => [file.repo, file.path]),
      [
        ["vault-optical-rl", "projects/optical-rl/assets/plot.png"],
        ["vault-optical-rl", "projects/optical-rl/files/Data Set/raw.csv"],
        ["vault-optical-rl", "projects/optical-rl/files/run.py"],
        ["vault-optical-rl", "projects/optical-rl/notes/x.qmd"],
      ],
    )
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-overlay-"))
    applyOverlay(files, target)
    assert.equal(fs.readFileSync(path.join(target, "projects/optical-rl/notes/x.qmd"), "utf8"), "x")
    fs.rmSync(target, { recursive: true, force: true })

    // Its documents are the private vault's, from its own git, with its repo; its folders too.
    const manifest = docsManifest(privateRoot, { excluded, restricted })
    assert.deepEqual(Object.keys(manifest), [
      "resources/files/big-laser/manual.pdf",
      "resources/projects/optical-rl/files/data-set/raw.csv",
      "resources/projects/optical-rl/files/run.py",
      "resources/projects/optical-rl/notes/x.qmd",
    ])
    assert.deepEqual(manifest["resources/projects/optical-rl/files/run.py"], {
      sha: execFileSync("git", ["-C", dir, "hash-object", "projects/optical-rl/files/run.py"], {
        encoding: "utf8",
      }).trim(),
      size: 8,
      contentType: "text/x-python; charset=utf-8",
      repo: "vault-optical-rl",
    })
    // A site path that isn't "resources/<vault path>" names the vault path.
    assert.equal(
      manifest["resources/projects/optical-rl/files/data-set/raw.csv"].path,
      "projects/optical-rl/files/Data Set/raw.csv",
    )
    assert.equal(
      manifest["resources/files/big-laser/manual.pdf"].path,
      "files/Big Laser/manual.pdf",
    )
    assert.equal(manifest["resources/files/big-laser/manual.pdf"].repo, undefined)
    const folders = vaultFolders(privateRoot, { excluded, restricted })
    assert.deepEqual(
      folders["resources/projects/optical-rl/files"].files.map((file) => file.name),
      ["run.py"],
    )
    assert.ok(folders["resources/projects/optical-rl"])

    // Each file's history is its own repository's.
    const histories = pageHistories(
      [
        { repo: "vault-private", dir: privateRoot, except: ["projects/optical-rl/"] },
        { repo: "vault-private", dir, only: "projects/optical-rl/" },
      ],
      [],
    )
    assert.deepEqual(Object.keys(histories).sort(), [
      "vault-private:files/Big Laser/manual.pdf",
      "vault-private:notes/a.md",
      "vault-private:projects/index.md",
      "vault-private:projects/optical-rl/assets/plot.png",
      "vault-private:projects/optical-rl/files/Data Set/raw.csv",
      "vault-private:projects/optical-rl/files/run.py",
      "vault-private:projects/optical-rl/notes/x.qmd",
    ])

    // A file outside the vault's folder, or one vault-private has, fails the build.
    fs.writeFileSync(path.join(dir, "stray.md"), "stray")
    assert.throws(
      () => overlayFiles(restricted, privateRoot, { excluded }),
      /stray\.md is outside the vault's folder projects\/optical-rl\//,
    )
    fs.rmSync(path.join(dir, "stray.md"))
    fs.mkdirSync(path.join(privateRoot, "projects/optical-rl/notes"), { recursive: true })
    fs.writeFileSync(path.join(privateRoot, "projects/optical-rl/notes/x.qmd"), "clash")
    assert.throws(
      () => overlayFiles(restricted, privateRoot, { excluded }),
      /projects\/optical-rl\/notes\/x\.qmd is in vault-private too/,
    )
  } finally {
    fs.rmSync(privateRoot, { recursive: true, force: true })
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a restricted vault's wolfram notebook stops the build; its other files don't", () => {
  checkSupported([
    { repo: "vault-optical-rl", path: "projects/optical-rl/notes/run.ipynb" },
    { repo: "vault-optical-rl", path: "projects/optical-rl/notes/meeting.qmd" },
  ])
  assert.throws(
    () => checkSupported([{ repo: "vault-optical-rl", path: "projects/optical-rl/sim/ring.nb" }]),
    /restricted Wolfram notebooks are not supported yet:\n {2}vault-optical-rl: projects\/optical-rl\/sim\/ring\.nb/,
  )
})
