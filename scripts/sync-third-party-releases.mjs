import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readManifestFromZipBuffer, scanZipBuffer } from './scan-plugin.mjs';

const MAX_PLUGIN_ARCHIVE_BYTES = 100 * 1024 * 1024;

export function parseSemver(raw) {
  const cleaned = String(raw || '').trim().replace(/^v/i, '');
  const m = cleaned.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : [],
  };
}

export function isNewerSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) return false;
  if (!pb) return true;
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch;
  if (pa.pre.length === 0 && pb.pre.length === 0) return false;
  if (pa.pre.length === 0) return true;
  if (pb.pre.length === 0) return false;
  const maxLen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < maxLen; i += 1) {
    if (i >= pa.pre.length) return false;
    if (i >= pb.pre.length) return true;
    const ta = pa.pre[i];
    const tb = pb.pre[i];
    if (ta === tb) continue;
    const na = /^\d+$/.test(ta) ? Number(ta) : null;
    const nb = /^\d+$/.test(tb) ? Number(tb) : null;
    if (na !== null && nb !== null) return na > nb;
    if (na !== null) return false;
    if (nb !== null) return true;
    return ta > tb;
  }
  return false;
}

export function pickBestReleaseAsset(releases, pluginId) {
  if (!Array.isArray(releases)) return null;
  let candidate = null;
  for (const rel of releases) {
    if (!rel || rel.draft || rel.prerelease) continue;
    for (const asset of rel.assets || []) {
      const name = String(asset?.name || '');
      const match = name.match(/^([A-Za-z0-9][A-Za-z0-9._-]{1,63})-v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.(zip|agypkg|agy-plugin)$/i);
      if (!match) continue;
      if (match[1].toLowerCase() !== String(pluginId || '').toLowerCase()) continue;
      const size = Number(asset?.size || 0);
      if (size > MAX_PLUGIN_ARCHIVE_BYTES) continue;
      const downloadUrl = String(asset?.browser_download_url || '').trim();
      if (!downloadUrl) continue;
      const ver = match[2];
      const parsed = parseSemver(ver);
      if (!parsed || parsed.pre.length > 0) continue;
      if (!candidate || isNewerSemver(ver, candidate.version)) {
        candidate = {
          version: ver,
          downloadUrl,
          tagName: String(rel.tag_name || ''),
          publishedAt: String(rel.published_at || ''),
          changelog: String(rel.body || '').trim(),
          assetName: name,
          size,
        };
      }
    }
  }
  return candidate;
}

export function validateSyncedManifest(zipBuf, expectedId, expectedVersion) {
  const manifest = readManifestFromZipBuffer(zipBuf);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('agy-plugin.json 清单格式无效');
  }
  if (manifest.schemaVersion !== undefined && Number(manifest.schemaVersion) !== 1) {
    throw new Error(`不支持的清单 schemaVersion: ${manifest.schemaVersion}`);
  }
  const manifestId = String(manifest.id || '').trim();
  if (!manifestId || manifestId.toLowerCase() !== String(expectedId || '').trim().toLowerCase()) {
    throw new Error(`压缩包清单 id (${manifestId || '缺失'}) 与目录插件 id (${expectedId}) 不一致`);
  }
  const rawManifestVer = String(manifest.version || '').trim();
  if (rawManifestVer) {
    const parsedManifestVer = parseSemver(rawManifestVer);
    if (!parsedManifestVer || parsedManifestVer.pre.length > 0) {
      throw new Error(`压缩包清单版本号无效或为预发布版: ${rawManifestVer}`);
    }
    const normalizedManifestVer = rawManifestVer.replace(/^v/i, '');
    const normalizedExpected = String(expectedVersion || '').trim().replace(/^v/i, '');
    if (normalizedExpected && normalizedManifestVer !== normalizedExpected) {
      throw new Error(`压缩包清单版本 (${normalizedManifestVer}) 与发布版本 (${normalizedExpected}) 不一致`);
    }
  }
  return manifest;
}

function rankFallbackAsset(assetName, pluginId) {
  const name = String(assetName || '').trim();
  const lower = name.toLowerCase();
  if (lower.endsWith('.exe') || !/\.(zip|agypkg|agy-plugin)$/i.test(lower)) return -1;
  const idLower = String(pluginId || '').trim().toLowerCase();
  const slugLower = idLower.includes('.') ? idLower.split('.').slice(1).join('.') : idLower;
  let score = lower.endsWith('.agypkg') || lower.endsWith('.agy-plugin') ? 2 : 0;
  if (idLower && lower.includes(idLower)) score += 3;
  else if (slugLower && lower.includes(slugLower)) score += 2;
  return score;
}

export async function resolveReleaseUpdateForPlugin(releases, item, downloadBufferFn) {
  if (!Array.isArray(releases)) return null;
  const namedCandidate = pickBestReleaseAsset(releases, item.id);
  if (namedCandidate && isNewerSemver(namedCandidate.version, item.version)) {
    const zipBuf = await downloadBufferFn(namedCandidate.downloadUrl);
    if (!Buffer.isBuffer(zipBuf) || zipBuf.length === 0 || zipBuf.length > MAX_PLUGIN_ARCHIVE_BYTES) {
      throw new Error(`插件包大小异常 (${zipBuf?.length || 0} bytes)`);
    }
    const manifest = validateSyncedManifest(zipBuf, item.id, namedCandidate.version);
    return { candidate: namedCandidate, zipBuf, manifest };
  }

  const stableNewerReleases = [];
  for (const rel of releases) {
    if (!rel || rel.draft || rel.prerelease) continue;
    const tagParsed = parseSemver(rel.tag_name);
    if (!tagParsed || tagParsed.pre.length > 0) continue;
    const tagVer = String(rel.tag_name || '').trim().replace(/^v/i, '');
    if (!isNewerSemver(tagVer, item.version)) continue;
    stableNewerReleases.push({ rel, tagVer });
  }
  stableNewerReleases.sort((a, b) => (
    isNewerSemver(b.tagVer, a.tagVer) ? 1 : isNewerSemver(a.tagVer, b.tagVer) ? -1 : 0
  ));

  for (const { rel, tagVer } of stableNewerReleases) {
    const assets = (rel.assets || [])
      .map((asset) => ({
        asset,
        score: rankFallbackAsset(asset?.name, item.id),
        size: Number(asset?.size || 0),
        downloadUrl: String(asset?.browser_download_url || '').trim(),
      }))
      .filter((entry) => entry.score >= 0 && entry.size <= MAX_PLUGIN_ARCHIVE_BYTES && entry.downloadUrl)
      .sort((a, b) => b.score - a.score);

    for (const { asset, downloadUrl } of assets) {
      let zipBuf;
      try {
        zipBuf = await downloadBufferFn(downloadUrl);
      } catch {
        continue;
      }
      if (!Buffer.isBuffer(zipBuf) || zipBuf.length === 0 || zipBuf.length > MAX_PLUGIN_ARCHIVE_BYTES) {
        continue;
      }
      let manifest;
      try {
        manifest = readManifestFromZipBuffer(zipBuf);
      } catch {
        continue;
      }
      if (String(manifest?.id || '').trim().toLowerCase() !== String(item.id || '').trim().toLowerCase()) {
        continue;
      }
      const rawManifestVer = String(manifest.version || '').trim();
      let resolvedVersion = tagVer;
      if (rawManifestVer) {
        const parsedManifestVer = parseSemver(rawManifestVer);
        if (!parsedManifestVer || parsedManifestVer.pre.length > 0) continue;
        resolvedVersion = rawManifestVer.replace(/^v/i, '');
      }
      if (!isNewerSemver(resolvedVersion, item.version)) continue;
      validateSyncedManifest(zipBuf, item.id, resolvedVersion);
      return {
        candidate: {
          version: resolvedVersion,
          downloadUrl,
          tagName: String(rel.tag_name || ''),
          publishedAt: String(rel.published_at || ''),
          changelog: String(rel.body || '').trim(),
          assetName: String(asset?.name || ''),
          size: zipBuf.length,
        },
        zipBuf,
        manifest,
      };
    }
  }
  return null;
}

async function githubFetch(url, headers = {}, timeoutMs = 25000) {
  const token = process.env.GITHUB_TOKEN || '';
  const merged = {
    'User-Agent': 'AGY-Dock-Sync-Bot',
    Accept: 'application/vnd.github+json',
    ...headers,
  };
  const parsedUrl = new URL(url);
  if (token && parsedUrl.hostname === 'api.github.com') {
    merged.Authorization = `Bearer ${token}`;
  }
  return fetch(url, { headers: merged, signal: AbortSignal.timeout(timeoutMs) });
}

export async function syncCatalogPlugins(plugins, options = {}) {
  const {
    isOfficial = false,
    pendingOfficial = [],
    fetchReleasesFn = async (repo) => {
      const relRes = await githubFetch(`https://api.github.com/repos/${repo}/releases?per_page=30`);
      if (!relRes.ok) {
        throw new Error(`HTTP ${relRes.status}`);
      }
      return relRes.json();
    },
    downloadBufferFn = async (downloadUrl) => {
      const dlRes = await githubFetch(downloadUrl, { Accept: 'application/octet-stream' }, 60000);
      if (!dlRes.ok) {
        throw new Error(`HTTP ${dlRes.status}`);
      }
      return Buffer.from(await dlRes.arrayBuffer());
    },
  } = options;

  let updatedCount = 0;

  for (const item of plugins) {
    const repo = String(item?.upstreamRepo || '').trim();
    if (!repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) continue;

    try {
      const releases = await fetchReleasesFn(repo, item);
      const resolved = await resolveReleaseUpdateForPlugin(releases, item, downloadBufferFn);
      if (!resolved) continue;

      const { candidate, zipBuf, manifest } = resolved;
      const scanReport = scanZipBuffer(zipBuf);
      const nextEntry = {
        ...item,
        version: candidate.version,
        downloadUrl: candidate.downloadUrl,
        sha256: createHash('sha256').update(zipBuf).digest('hex'),
        size: zipBuf.length,
        releaseTag: candidate.tagName,
        changelog: candidate.changelog,
        ...(candidate.publishedAt ? { publishedAt: candidate.publishedAt } : {}),
        ...(manifest?.type ? { type: String(manifest.type).trim() } : {}),
        riskLevel: scanReport.riskLevel,
        riskFindings: scanReport.findings,
      };

      if (scanReport.blocked) {
        if (isOfficial) {
          pendingOfficial.push({
            id: item.id,
            name: item.name,
            fromVersion: item.version,
            toVersion: candidate.version,
            upstreamRepo: repo,
            entry: nextEntry,
            scanReport,
          });
          console.log(`[REVIEW] ${item.id} v${candidate.version} 命中高危规则，已加入官方新版人工复核队列`);
        } else {
          console.error(`[BLOCKED] ${item.id} v${candidate.version} 未通过安全筛查，已拒绝自动同步: ${scanReport.summary}`);
        }
        continue;
      }

      Object.assign(item, nextEntry);
      updatedCount += 1;
      console.log(`[UPDATED] ${item.id} -> v${candidate.version} (${scanReport.riskLevel})`);
    } catch (err) {
      console.warn(`[WARN] 跳过 ${item?.id || 'unknown'} (${repo}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return updatedCount;
}

async function syncCatalogFile(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return 0;
  const catalog = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : [];
  const updatedCount = await syncCatalogPlugins(plugins, options);

  if (updatedCount > 0) {
    catalog.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
  }
  return updatedCount;
}

async function main() {
  const pendingOfficial = [];
  const c1 = await syncCatalogFile('plugins-catalog.json', { isOfficial: true, pendingOfficial });
  const c2 = await syncCatalogFile('third-party-catalog.json', { isOfficial: false });
  const pendingPath = path.resolve('sync-pending-official.json');
  if (pendingOfficial.length > 0) {
    fs.writeFileSync(pendingPath, JSON.stringify(pendingOfficial, null, 2) + '\n', 'utf8');
  } else if (fs.existsSync(pendingPath)) {
    fs.unlinkSync(pendingPath);
  }
  console.log(`同步完成：官方目录更新 ${c1} 项（待人工复核 ${pendingOfficial.length} 项），第三方目录更新 ${c2} 项`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
