#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const configPath = resolve(args.config ?? "input_repos.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const outputPath = resolve(args.output ?? config.output ?? "repo.json");
const duplicatePolicy = args["duplicate-policy"] ?? config.duplicatePolicy ?? "keep-first";
const invalidDownloadPolicy = args["invalid-download-policy"] ?? config.invalidDownloadPolicy ?? "error";
const preserveOrder = args["preserve-order"] != null ? toBoolean(args["preserve-order"]) : config.preserveOrder !== false;

if (!["keep-first", "keep-last", "error"].includes(duplicatePolicy)) {
  throw new Error(`Invalid duplicatePolicy "${duplicatePolicy}". Use keep-first, keep-last, or error.`);
}

if (!["error", "skip", "keep"].includes(invalidDownloadPolicy)) {
  throw new Error(`Invalid invalidDownloadPolicy "${invalidDownloadPolicy}". Use error, skip, or keep.`);
}

if (!Array.isArray(config.repositories) || config.repositories.length === 0) {
  throw new Error(`No repositories configured in ${configPath}.`);
}

const merged = [];
const seen = new Map();
const duplicates = [];
const invalidDownloads = [];

for (const [index, source] of config.repositories.entries()) {
  const url = sourceToUrl(source);
  const label = sourceLabel(source, url);
  console.log(`Fetching ${label}`);

  const repoJson = await fetchJson(url);
  const entries = (await normalizeEntries(repoJson, label, source)).map((entry) => applySourceOverrides(entry, source));

  for (const entry of entries) {
    const key = pluginKey(entry);
    const failedDownloads = await validateDownloadLinks(entry);

    if (failedDownloads.length > 0) {
      invalidDownloads.push({ key: key || "(unknown plugin)", source: label, downloads: failedDownloads });

      if (invalidDownloadPolicy === "error") {
        continue;
      }

      if (invalidDownloadPolicy === "skip") {
        continue;
      }
    }

    if (key && seen.has(key)) {
      duplicates.push({ key, source: label });

      if (duplicatePolicy === "error") {
        continue;
      }

      if (duplicatePolicy === "keep-last") {
        const previousIndex = seen.get(key);
        merged[previousIndex] = entry;
      }

      continue;
    }

    if (key) {
      seen.set(key, merged.length);
    }

    merged.push(entry);
  }

  console.log(`  Added ${entries.length} entries from source ${index + 1}`);
}

if (duplicatePolicy === "error" && duplicates.length > 0) {
  const list = duplicates.map((item) => `- ${item.key} from ${item.source}`).join("\n");
  throw new Error(`Duplicate plugins found:\n${list}`);
}

if (invalidDownloadPolicy === "error" && invalidDownloads.length > 0) {
  const list = invalidDownloads
    .flatMap((item) => item.downloads.map((download) => `- ${item.key} from ${item.source}: ${download.field} ${download.status} ${download.url}`))
    .join("\n");
  throw new Error(`Invalid plugin download links found:\n${list}`);
}

const output = preserveOrder
  ? merged
  : [...merged].sort((a, b) => pluginKey(a).localeCompare(pluginKey(b)));

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

console.log(`Wrote ${merged.length} plugin entries to ${outputPath}`);
if (duplicates.length > 0) {
  console.log(`Skipped or replaced ${duplicates.length} duplicate entries using "${duplicatePolicy}".`);
}
if (invalidDownloads.length > 0) {
  console.log(`Found ${invalidDownloads.length} plugin entries with invalid download links using "${invalidDownloadPolicy}".`);
}

function parseArgs(rawArgs) {
  const parsed = {};

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument "${arg}".`);
    }

    const [name, inlineValue] = arg.slice(2).split("=", 2);
    const nextValue = rawArgs[i + 1];

    if (inlineValue != null) {
      parsed[name] = inlineValue;
    } else if (nextValue && !nextValue.startsWith("--")) {
      parsed[name] = nextValue;
      i += 1;
    } else {
      parsed[name] = true;
    }
  }

  return parsed;
}

function toBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (["true", "1", "yes"].includes(String(value).toLowerCase())) {
    return true;
  }

  if (["false", "0", "no"].includes(String(value).toLowerCase())) {
    return false;
  }

  throw new Error(`Expected boolean value, got "${value}".`);
}

function sourceToUrl(source) {
  if (typeof source === "string") {
    return stringSourceToUrl(source);
  }

  if (source && typeof source === "object") {
    if (source.url) {
      return stringSourceToUrl(source.url);
    }

    if (source.owner && source.repo) {
      const branch = source.branch ?? "main";
      const path = source.path ?? "repo.json";
      return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${branch}/${path}`;
    }
  }

  throw new Error(`Invalid repository source: ${JSON.stringify(source)}`);
}

function stringSourceToUrl(source) {
  if (/^https?:\/\//i.test(source)) {
    return source
      .replace("https://github.com/", "https://raw.githubusercontent.com/")
      .replace("/blob/", "/");
  }

  const ownerRepo = source.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (ownerRepo) {
    return `https://raw.githubusercontent.com/${ownerRepo[1]}/${ownerRepo[2]}/main/repo.json`;
  }

  throw new Error(`String repository sources must be a URL or owner/repo, got "${source}".`);
}

function sourceLabel(source, url) {
  if (typeof source === "string") {
    return source;
  }

  if (source?.owner && source?.repo) {
    return `${source.owner}/${source.repo}`;
  }

  return source?.url ?? url;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "dalamud-repo-merger"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function normalizeEntries(repoJson, label, source) {
  if (Array.isArray(repoJson)) {
    return repoJson;
  }

  if (Array.isArray(repoJson?.plugins)) {
    return repoJson.plugins;
  }

  if (Array.isArray(repoJson?.PluginMaster)) {
    return repoJson.PluginMaster;
  }

  if (isPluginEntry(repoJson)) {
    return [await normalizePluginEntry(repoJson, source)];
  }

  throw new Error(`${label} did not return a Dalamud repo array.`);
}

function isPluginEntry(entry) {
  return Boolean(entry && typeof entry === "object" && pluginKey(entry));
}

function applySourceOverrides(entry, source) {
  if (!source || typeof source !== "object" || !source.overrides || typeof source.overrides !== "object") {
    return entry;
  }

  return { ...entry, ...source.overrides };
}

async function normalizePluginEntry(entry, source) {
  const normalized = { ...entry };

  if (source && typeof source === "object" && source.owner && source.repo) {
    const owner = source.owner;
    const repo = source.repo;
    const repoUrl = `https://github.com/${owner}/${repo}`;
    const releaseAsset = source.releaseAsset ?? "latest.zip";
    const releaseTag = source.releaseTag ?? "latest";

    if (!normalized.RepoUrl || source.preferSourceRepoUrl === true) {
      normalized.RepoUrl = repoUrl;
    }

    if (!normalized.DownloadLinkInstall || !normalized.DownloadLinkUpdate || !normalized.DownloadLinkTesting) {
      const downloadUrl = releaseTag === "latest"
        ? await latestReleaseAssetUrl(owner, repo, releaseAsset)
        : `${repoUrl}/releases/download/${releaseTag}/${releaseAsset}`;

      normalized.DownloadLinkInstall ??= downloadUrl;
      normalized.DownloadLinkUpdate ??= downloadUrl;
      normalized.DownloadLinkTesting ??= downloadUrl;
    }
  }

  return normalized;
}

async function latestReleaseAssetUrl(owner, repo, assetName) {
  const release = await fetchJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
  const asset = release.assets?.find((item) => item.name === assetName);

  if (!asset?.browser_download_url) {
    throw new Error(`Latest release for ${owner}/${repo} does not include ${assetName}.`);
  }

  return asset.browser_download_url;
}

async function validateDownloadLinks(entry) {
  const fields = ["DownloadLinkInstall", "DownloadLinkUpdate", "DownloadLinkTesting"];
  const failures = [];

  for (const field of fields) {
    const url = entry?.[field];

    if (!url) {
      continue;
    }

    const status = await fetchStatus(url);
    if (status < 200 || status >= 400) {
      failures.push({ field, status, url });
    }
  }

  return failures;
}

async function fetchStatus(url) {
  let response = await fetch(url, {
    method: "HEAD",
    headers: {
      "User-Agent": "dalamud-repo-merger"
    }
  });

  if (response.status === 405) {
    response = await fetch(url, {
      headers: {
        "User-Agent": "dalamud-repo-merger"
      }
    });
  }

  return response.status;
}

function pluginKey(entry) {
  return String(entry?.InternalName ?? entry?.Name ?? entry?.AssemblyName ?? "").trim();
}
