import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import {
  collectReleaseAssetCandidates,
  evaluateSubmissionRiskPolicy,
  rankPluginAssetCandidate,
  selectValidPluginFromReleases,
} from './process-plugin-submission.mjs';
import { hasCredentialTheftRisk, scanZipBuffer, stripComments } from './scan-plugin.mjs';
import {
  isNewerSemver,
  pickBestReleaseAsset,
  syncCatalogPlugins,
} from './sync-third-party-releases.mjs';

function buildDeflatedZip(files) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const rawBuf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const compBuf = zlib.deflateRawSync(rawBuf);
    const crc = zlib.crc32(rawBuf);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compBuf.length, 18);
    local.writeUInt32LE(rawBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    localParts.push(local, compBuf);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10); // deflate
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compBuf.length, 20);
    cd.writeUInt32LE(rawBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    cdParts.push(cd);

    offset += local.length + compBuf.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(cdParts.length, 8);
  eocd.writeUInt16LE(cdParts.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function buildStoredZip(files) {
  const localParts = [];
  const cdParts = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const crc = zlib.crc32(dataBuf);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBuf.length, 18);
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    localParts.push(local, dataBuf);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    cdParts.push(cd);

    offset += local.length + dataBuf.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(cdParts.length, 8);
  eocd.writeUInt16LE(cdParts.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

test('rankPluginAssetCandidate excludes non-plugin formats and ranks owner-prefixed packages highest', () => {
  assert.equal(rankPluginAssetCandidate('setup.exe', 'zhangsan'), -1);
  assert.equal(rankPluginAssetCandidate('source.tar.gz', 'zhangsan'), -1);
  assert.equal(rankPluginAssetCandidate('docs.zip', 'zhangsan'), 0);
  assert.equal(rankPluginAssetCandidate('my-helper.agypkg', 'zhangsan'), 1);
  assert.equal(rankPluginAssetCandidate('my-helper-v1.0.0.zip', 'zhangsan'), 2);
  assert.equal(rankPluginAssetCandidate('zhangsan.my-helper-v1.0.0.zip', 'zhangsan'), 3);
});

test('selectValidPluginFromReleases skips docs/mac zips and binary files to pick valid plugin archive', async () => {
  const docsZip = buildStoredZip({ 'README.txt': 'documentation' });
  const pluginZip = buildStoredZip({
    'agy-plugin.json': JSON.stringify({
      schemaVersion: 1,
      id: 'zhangsan.helper',
      name: 'Helper',
      version: '1.0.0',
    }),
    'index.js': 'console.log("ok");',
  });

  const releases = [
    {
      draft: false,
      tag_name: 'v1.0.0',
      published_at: '2026-11-24T00:00:00Z',
      body: 'Release notes',
      assets: [
        { name: 'installer.exe', size: 1000, browser_download_url: 'https://example.invalid/installer.exe' },
        { name: '00-docs-v1.0.0.zip', size: docsZip.length, browser_download_url: 'https://example.invalid/docs.zip' },
        { name: 'archive.tar.gz', size: 1000, browser_download_url: 'https://example.invalid/archive.tar.gz' },
        { name: 'zhangsan.helper-v1.0.0.zip', size: pluginZip.length, browser_download_url: 'https://example.invalid/plugin.zip' },
      ],
    },
  ];

  const sorted = collectReleaseAssetCandidates(releases, 'zhangsan');
  assert.equal(sorted[0].assetName, 'zhangsan.helper-v1.0.0.zip');

  const picked = await selectValidPluginFromReleases(
    releases,
    'zhangsan/helper',
    'Helper',
    async (url) => (url.endsWith('docs.zip') ? docsZip : pluginZip),
  );
  assert.equal(picked.manifest.id, 'zhangsan.helper');
  assert.equal(picked.assetInfo.assetName, 'zhangsan.helper-v1.0.0.zip');
});

test('selectValidPluginFromReleases handles non-standard asset zip names by inspecting manifest inside', async () => {
  const docsZip = buildStoredZip({ 'notes.md': '# hi' });
  const pluginZip = buildStoredZip({
    'agy-plugin.json': JSON.stringify({
      schemaVersion: 1,
      id: 'zhangsan.helper',
      name: 'Helper',
      version: '1.0.0',
    }),
  });

  const releases = [
    {
      draft: false,
      tag_name: 'v1.0.0',
      assets: [
        { name: '01-screenshots.zip', size: docsZip.length, browser_download_url: 'https://example.invalid/docs.zip' },
        { name: 'bundle.zip', size: pluginZip.length, browser_download_url: 'https://example.invalid/bundle.zip' },
      ],
    },
  ];

  const picked = await selectValidPluginFromReleases(
    releases,
    'zhangsan/helper',
    'Helper',
    async (url) => (url.endsWith('docs.zip') ? docsZip : pluginZip),
  );
  assert.equal(picked.assetInfo.assetName, 'bundle.zip');
  assert.equal(picked.manifest.id, 'zhangsan.helper');
});

test('evaluateSubmissionRiskPolicy keeps third-party hard-blocked while routing official high-risk to manual PR review', () => {
  const highReport = { riskLevel: 'high', blocked: true, findings: [{ severity: 'high', title: 'exe' }] };
  assert.deepEqual(evaluateSubmissionRiskPolicy('third-party', highReport), {
    blocked: true,
    highRiskWarning: false,
  });
  assert.deepEqual(evaluateSubmissionRiskPolicy('official', highReport), {
    blocked: false,
    highRiskWarning: true,
  });
});

test('scanner ignores comments and defensive credential denylist while catching real threats', () => {
  const safeZip = buildStoredZip({
    'agy-plugin.json': JSON.stringify({
      schemaVersion: 1,
      id: 'demo.safe',
      name: 'Safe Plugin',
      version: '1.0.0',
      type: 'node-cdp',
      command: 'node',
      launchArgs: ['plugins\\demo.safe\\index.js'],
    }),
    'index.js': `
      // 固定无插值 PowerShell 脚本说明（通过 powershell -EncodedCommand 执行）
      /* taskkill /F /PID 9999 示例说明 */
      const SENSITIVE_BASENAMES = new Set([
        'login data',
        'local state',
        'web data',
      ]);
      const url = 'https://example.invalid/keep//inside-string';
      console.log(SENSITIVE_BASENAMES.size, url);
    `,
  });
  const safeReport = scanZipBuffer(safeZip);
  assert.equal(safeReport.blocked, false);
  assert.equal(safeReport.riskLevel, 'none');

  const stripped = stripComments("// taskkill /F\nconst s = 'https://a.b//c';", 'js');
  assert.equal(stripped.includes('taskkill'), false);
  assert.equal(stripped.includes('https://a.b//c'), true);

  assert.equal(hasCredentialTheftRisk("const SENSITIVE_BASENAMES = new Set(['login data', 'local state']);"), false);
  const longDenylist = [
    'const SENSITIVE_BASENAMES = new Set([',
    ...Array.from({ length: 22 }, (_, i) => `  'item-${i}.json',`),
    "  'login data',",
    "  'login data-journal',",
    "  'local state',",
    "  'web data',",
    ']);',
  ].join('\n');
  assert.equal(hasCredentialTheftRisk(longDenylist), false);
  assert.equal(hasCredentialTheftRisk("fs.readFileSync(path.join(dir, 'Chrome/User Data/Default/Login Data'));"), true);
  assert.equal(hasCredentialTheftRisk("fs.readFileSync(path.join(dir, 'Login Data-journal'));"), true);
  const nonListGap = [
    'const sensitive = true;',
    ...Array.from({ length: 15 }, () => 'const a = 1;'),
    "const f = 'login data';",
  ].join('\n');
  assert.equal(hasCredentialTheftRisk(nonListGap), true);
  assert.equal(hasCredentialTheftRisk("const SENSITIVE_BASENAMES = new Set(['Default/Login Data']);"), true);
  assert.equal(hasCredentialTheftRisk("const SENSITIVE_BASENAMES = []; const x = 'CryptUnprotectData';"), true);

  const evalZip = buildStoredZip({
    'agy-plugin.json': JSON.stringify({ schemaVersion: 1, id: 'bad.eval', command: 'node', launchArgs: [] }),
    'index.js': "execSync('powershell -EncodedCommand abc');",
  });
  const evalReport = scanZipBuffer(evalZip);
  assert.equal(evalReport.blocked, true);
  assert.ok(evalReport.findings.some((f) => f.code === 'OBFUSCATED_EXECUTION'));
});

test('sync-third-party-releases skips prereleases and ranks stable semver higher than beta', () => {
  assert.equal(isNewerSemver('1.0.8', '1.0.8-beta.1'), true);
  assert.equal(isNewerSemver('1.0.8-beta.1', '1.0.8'), false);
  assert.equal(isNewerSemver('1.0.8-beta.2', '1.0.8-beta.1'), true);

  const releases = [
    {
      draft: false,
      prerelease: true,
      tag_name: 'v1.0.9-beta.1',
      assets: [
        { name: 'alice.tool-v1.0.9-beta.1.zip', browser_download_url: 'https://example.invalid/beta.zip' },
      ],
    },
    {
      draft: false,
      prerelease: false,
      tag_name: 'v1.0.8',
      assets: [
        { name: 'alice.tool-v1.0.8-rc.1.zip', browser_download_url: 'https://example.invalid/rc.zip' },
        { name: 'alice.tool-v1.0.8.zip', browser_download_url: 'https://example.invalid/stable.zip' },
      ],
    },
  ];
  const picked = pickBestReleaseAsset(releases, 'alice.tool');
  assert.equal(picked?.version, '1.0.8');
  assert.equal(picked?.downloadUrl, 'https://example.invalid/stable.zip');
});

test('scanner catches oversized compressed PE binary, oversized code file, zip-slip path, and nested manifest spoof', () => {
  const oversizedPeZip = buildDeflatedZip({
    'agy-plugin.json': JSON.stringify({ schemaVersion: 1, id: 'alice.tool', command: 'node', launchArgs: [] }),
    'payload.dat': Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(5 * 1024 * 1024, 0x41)]),
  });
  const peReport = scanZipBuffer(oversizedPeZip);
  assert.equal(peReport.blocked, true);
  assert.ok(peReport.findings.some((f) => f.code === 'BANNED_PE_BINARY'));

  const oversizedCodeZip = buildDeflatedZip({
    'agy-plugin.json': JSON.stringify({ schemaVersion: 1, id: 'alice.tool', command: 'node', launchArgs: [] }),
    'huge.js': Buffer.from(`console.log("ok");\n${'a'.repeat(5 * 1024 * 1024)}`),
  });
  const codeReport = scanZipBuffer(oversizedCodeZip);
  assert.equal(codeReport.blocked, true);
  assert.ok(codeReport.findings.some((f) => f.code === 'OVERSIZED_CODE_FILE'));

  const slipZip = buildStoredZip({
    'agy-plugin.json': JSON.stringify({ schemaVersion: 1, id: 'alice.tool', command: 'node', launchArgs: [] }),
    '../escape.js': 'console.log(1);',
  });
  const slipReport = scanZipBuffer(slipZip);
  assert.equal(slipReport.blocked, true);
  assert.ok(slipReport.findings.some((f) => f.code === 'UNSAFE_ARCHIVE_PATH'));

  const nestedSpoofZip = buildStoredZip({
    'agy-plugin.json': JSON.stringify({ schemaVersion: 1, id: 'alice.tool', command: 'node', launchArgs: [] }),
    'fixtures/agy-plugin.json': JSON.stringify({ schemaVersion: 1, id: 'alice.tool', type: 'exe-cdp', command: 'evil.exe' }),
  });
  const nestedReport = scanZipBuffer(nestedSpoofZip);
  assert.equal(nestedReport.blocked, false);
});

test('syncCatalogPlugins isolates per-plugin errors, validates manifests, supports non-standard asset names, clears stale changelogs, and skips >100MB assets', async () => {
  const validV2Zip = buildStoredZip({
    'agy-plugin.json': JSON.stringify({
      schemaVersion: 1,
      id: 'bob.good',
      version: '2.0.0',
      type: 'node-cdp',
      command: 'node',
      launchArgs: ['index.js'],
    }),
    'index.js': 'console.log("v2");',
  });

  const nonStandardZip = buildStoredZip({
    'agy-plugin.json': JSON.stringify({
      schemaVersion: 1,
      id: 'carol.custom',
      version: '1.1.0',
      type: 'node-cdp',
      command: 'node',
      launchArgs: ['index.js'],
    }),
    'index.js': 'console.log("custom");',
  });

  const badManifestZip = buildStoredZip({
    'agy-plugin.json': JSON.stringify({
      schemaVersion: 1,
      id: 'dave.wrong-id',
      version: '1.1.0',
    }),
  });

  const docsOnlyZip = buildStoredZip({ 'README.md': '# docs' });

  const catalogPlugins = [
    {
      id: 'alice.broken',
      name: 'Broken',
      version: '1.0.0',
      upstreamRepo: 'alice/broken',
      changelog: 'old',
    },
    {
      id: 'dave.mismatched',
      name: 'Mismatched',
      version: '1.0.0',
      upstreamRepo: 'dave/mismatched',
      changelog: 'old',
    },
    {
      id: 'eve.huge',
      name: 'Huge',
      version: '1.0.0',
      upstreamRepo: 'eve/huge',
      changelog: 'old',
    },
    {
      id: 'bob.good',
      name: 'Good',
      version: '1.0.0',
      upstreamRepo: 'bob/good',
      changelog: 'stale v1 changelog',
    },
    {
      id: 'carol.custom',
      name: 'Custom',
      version: '1.0.0',
      upstreamRepo: 'carol/custom',
      changelog: 'old v1',
    },
  ];

  const downloadedUrls = [];
  const updated = await syncCatalogPlugins(catalogPlugins, {
    isOfficial: false,
    fetchReleasesFn: async (repo) => {
      if (repo === 'alice/broken') throw new Error('ETIMEDOUT');
      if (repo === 'dave/mismatched') {
        return [{
          draft: false,
          prerelease: false,
          tag_name: 'v1.1.0',
          body: 'bad manifest',
          assets: [{ name: 'dave.mismatched-v1.1.0.zip', size: badManifestZip.length, browser_download_url: 'https://example.invalid/dave.zip' }],
        }];
      }
      if (repo === 'eve/huge') {
        return [{
          draft: false,
          prerelease: false,
          tag_name: 'v2.0.0',
          body: 'huge file',
          assets: [{ name: 'eve.huge-v2.0.0.zip', size: 150 * 1024 * 1024, browser_download_url: 'https://example.invalid/huge.zip' }],
        }];
      }
      if (repo === 'bob/good') {
        return [{
          draft: false,
          prerelease: false,
          tag_name: 'v2.0.0',
          published_at: '2026-11-25T10:00:00Z',
          body: '',
          assets: [{ name: 'bob.good-v2.0.0.zip', size: validV2Zip.length, browser_download_url: 'https://example.invalid/bob.zip' }],
        }];
      }
      if (repo === 'carol/custom') {
        return [{
          draft: false,
          prerelease: false,
          tag_name: 'v1.1.0',
          published_at: '2026-11-25T10:05:00Z',
          body: 'Updated with non-standard zip name',
          assets: [
            { name: '00-docs.zip', size: docsOnlyZip.length, browser_download_url: 'https://example.invalid/docs.zip' },
            { name: 'bundle.zip', size: nonStandardZip.length, browser_download_url: 'https://example.invalid/bundle.zip' },
          ],
        }];
      }
      return [];
    },
    downloadBufferFn: async (url) => {
      downloadedUrls.push(url);
      if (url.endsWith('/dave.zip')) return badManifestZip;
      if (url.endsWith('/bob.zip')) return validV2Zip;
      if (url.endsWith('/docs.zip')) return docsOnlyZip;
      if (url.endsWith('/bundle.zip')) return nonStandardZip;
      throw new Error(`unexpected download ${url}`);
    },
  });

  assert.equal(updated, 2);
  assert.equal(catalogPlugins[0].version, '1.0.0');
  assert.equal(catalogPlugins[1].version, '1.0.0');
  assert.equal(catalogPlugins[2].version, '1.0.0');
  assert.equal(downloadedUrls.includes('https://example.invalid/huge.zip'), false);
  assert.equal(catalogPlugins[3].version, '2.0.0');
  assert.equal(catalogPlugins[3].changelog, '');
  assert.equal(catalogPlugins[4].version, '1.1.0');
  assert.equal(catalogPlugins[4].downloadUrl, 'https://example.invalid/bundle.zip');
});
