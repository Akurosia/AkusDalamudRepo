# Dalamud Repo Merger

Small GitHub repo that builds one combined Dalamud `repo.json` from a predefined list of custom plugin repositories.

Dalamud custom repositories are JSON files containing an array of plugin/store entries. This project fetches each configured source, concatenates the entries, removes duplicates, and writes a single `repo.json` you can add to Dalamud.

## Setup

1. Edit `input_repos.json`.
2. Add your source repositories under `repositories`.
3. Push this repo to GitHub.
4. In GitHub, open **Actions** -> **Merge Dalamud repos** -> **Run workflow**.

After the workflow runs, the merged file will be committed to `repo.json` by default.

## Source Formats

You can use raw URLs:

```json
{
  "repositories": [
    "https://raw.githubusercontent.com/OWNER/REPO/main/repo.json"
  ]
}
```

Or GitHub repo objects:

```json
{
  "repositories": [
    {
      "owner": "OWNER",
      "repo": "REPO",
      "branch": "main",
      "path": "repo.json"
    }
  ]
}
```

Simple `owner/repo` strings also work. They default to `main` and `repo.json`.

Repo objects may also point at a single Dalamud plugin manifest such as `PluginName/PluginName.json`.
When that manifest does not include download links, the merger fills install, update, and testing links from
the repository's latest GitHub release asset named `latest.zip` by default. Use `releaseTag` or
`releaseAsset` on the source object to override those defaults.

## Duplicate Handling

The first source wins by default. Put higher-priority repositories earlier in `input_repos.json`.

Change `duplicatePolicy` in `input_repos.json` if you want different behavior:

- `keep-first`: keep the first plugin entry seen
- `keep-last`: replace earlier plugin entries with later ones
- `error`: fail if duplicates are found

Plugins are matched by `InternalName`, then `Name`, then `AssemblyName`.

## Download Validation

The merger validates `DownloadLinkInstall`, `DownloadLinkUpdate`, and `DownloadLinkTesting` before writing the
merged repo. Set `invalidDownloadPolicy` in `input_repos.json` to choose how dead links are handled:

- `error`: fail the merge when a plugin has a broken download link
- `skip`: omit plugins with broken download links
- `keep`: keep entries even when a download link is currently broken

## Manual Local Run

```powershell
node scripts/merge-repos.mjs --config input_repos.json --output repo.json
```
