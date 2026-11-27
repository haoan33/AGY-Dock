import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_BASE_DIR = path.resolve(__dirname, '..');
export const DEFAULT_NO_PROXY = '127.0.0.1,localhost,::1';
export const APP_VERSION = '2.10.0';
export const DEFAULT_UPDATE_SITE_URL = 'https://www.haoanlab.xyz';
export const DEFAULT_PRODUCT_SLUG = 'agy-plugin-manager';
const UPDATE_SEMVER_RE = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\s*$/;
const PRODUCT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUPPORTED_PACKAGE_EXTS = new Set(['.zip', '.agypkg', '.agy-plugin']);
const VALID_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/i;
function isValidPluginId(id) {
  const clean = String(id || '').trim();
  return VALID_PLUGIN_ID_RE.test(clean) && !clean.endsWith('.') && !clean.includes('..');
}
const PROXY_PROCESS_NAMES = [
  'clash-verge',
  'flclash',
  'clash',
  'mihomo',
  'v2ray',
  'xray',
  'sing-box',
  'nekoray',
  'hiddify',
  'shadowsocks',
];
const COMMON_PROXY_PORTS = [7897, 7890, 10808, 10809, 1080, 2080, 2081, 7891, 8080];
const SOCKS_ONLY_PORTS = new Set([1080, 2080, 7891, 10808]);
const MIXED_PROXY_PORTS = new Set([7897, 7890]);
const ANTIGRAVITY_INSTALLER_SKIP_RE = /(?:agy-launcher|plugin[\s_-]*manager|agy[\s_-]*dock)/i;

function hasRemoteDebuggingPortArg(args) {
  return args.some((arg) => {
    const trimmed = String(arg || '').trim().toLowerCase();
    return (
      trimmed === '--remote-debugging-port' ||
      trimmed.startsWith('--remote-debugging-port=') ||
      trimmed === '-remote-debugging-port' ||
      trimmed.startsWith('-remote-debugging-port=')
    );
  });
}

/**
 * Builds Antigravity CLI args and environment variables with optional on-demand proxy injection.
 */
function normalizeNoProxyList(raw) {
  const seen = new Set();
  const items = [];
  for (const part of String(raw || '').split(/[,;\s]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      items.push(trimmed);
    }
  }
  return items.length > 0 ? items.join(',') : DEFAULT_NO_PROXY;
}

function hasProxyBypassListArg(args) {
  return (Array.isArray(args) ? args : []).some((arg) => {
    const trimmed = String(arg || '').trim().toLowerCase();
    return (
      trimmed === '--proxy-bypass-list' ||
      trimmed.startsWith('--proxy-bypass-list=') ||
      trimmed === '-proxy-bypass-list' ||
      trimmed.startsWith('-proxy-bypass-list=')
    );
  });
}

export function buildAntigravityLaunchParams(config, baseEnv = process.env) {
  const agyArgs = Array.isArray(config?.antigravityArgs)
    ? config.antigravityArgs.map((x) => String(x))
    : [];
  if (!hasRemoteDebuggingPortArg(agyArgs)) {
    agyArgs.push('--remote-debugging-port=0');
  }
  const env = { ...baseEnv };
  const proxy = config?.proxy || {};
  if (!proxy.enabled) {
    return { agyArgs, env, proxyInjected: false };
  }

  const setEnvPair = (upperKey, value) => {
    env[upperKey] = value;
    env[upperKey.toLowerCase()] = value;
  };

  if (proxy.httpProxy) setEnvPair('HTTP_PROXY', String(proxy.httpProxy).trim());
  if (proxy.httpsProxy) setEnvPair('HTTPS_PROXY', String(proxy.httpsProxy).trim());
  if (proxy.allProxy) setEnvPair('ALL_PROXY', String(proxy.allProxy).trim());

  const noProxy = String(proxy.noProxy || '').trim()
    ? normalizeNoProxyList(proxy.noProxy)
    : DEFAULT_NO_PROXY;
  setEnvPair('NO_PROXY', noProxy);

  if (proxy.electronProxyServer) {
    agyArgs.push(`--proxy-server=${String(proxy.electronProxyServer).trim()}`);
    if (!hasProxyBypassListArg(agyArgs)) {
      const bypassList = noProxy.split(',').filter(Boolean).join(';');
      if (bypassList) {
        agyArgs.push(`--proxy-bypass-list=${bypassList}`);
      }
    }
  }
  return { agyArgs, env, proxyInjected: true };
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Parses %APPDATA%\Antigravity\DevToolsActivePort content into { port, wsPath }.
 */
export function parseDevToolsActivePort(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const port = Number.parseInt(lines[0], 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    port,
    wsPath: lines[1] || null,
  };
}

const MANAGED_PLUGIN_SCRIPT_RE = /(?:^|[\s"'\\/])plugins[\\/]+[a-z0-9][a-z0-9._-]*[\\/]+[^\\/\s"']+\.(?:m?js|cjs)(?:\s|$|["'])/i;

/**
 * Returns true when a process is hosting a managed JS plugin runtime.
 */
export function isManagedPluginRuntimeProcess(proc) {
  if (!proc) return false;
  const cmd = String(proc.CommandLine || '');
  return cmd.toLowerCase().includes('--agy-node-runtime') || MANAGED_PLUGIN_SCRIPT_RE.test(cmd);
}

/**
 * Classifies Antigravity.exe processes into main GUI, sidecar runtime, and Chromium child processes.
 */
export function classifyAntigravityProcesses(processes) {
  const all = [];
  const main = [];
  const sidecar = [];
  const child = [];
  const list = Array.isArray(processes) ? processes : [];
  const byPid = new Map();
  for (const proc of list) {
    const pid = Number(proc?.ProcessId);
    if (Number.isInteger(pid)) {
      byPid.set(pid, proc);
    }
  }

  for (const proc of list) {
    const name = String(proc?.Name || '');
    if (name.toLowerCase() !== 'antigravity.exe') continue;
    if (isManagedPluginRuntimeProcess(proc)) continue;
    all.push(proc);
    const cmd = String(proc?.CommandLine || '');
    const lower = cmd.toLowerCase();
    const ppid = Number(proc?.ParentProcessId);
    const parent = Number.isInteger(ppid) ? byPid.get(ppid) : null;
    const parentName = String(parent?.Name || '').toLowerCase();
    const parentCmd = String(parent?.CommandLine || '').toLowerCase();
    const parentIsSidecarHost =
      parentName === 'language_server.exe' ||
      (parentName === 'cmd.exe' && parentCmd.includes('agy-node.cmd'));

    const isSidecar =
      parentIsSidecarHost ||
      lower.includes('sidecar_sdk') ||
      lower.includes('register_loader') ||
      lower.includes('--inspect-port=') ||
      lower.includes('--import=') ||
      lower.includes('mcp_entry') ||
      lower.includes('sidecars\\') ||
      lower.includes('sidecars/') ||
      lower.includes('--ms-enable-electron-run-as-node') ||
      lower.includes('dist/server.') ||
      lower.includes('dist\\server.') ||
      lower.includes('main.mjs') ||
      lower.includes('launch.mjs');

    const isChild = lower.includes('--type=') || !cmd.trim();

    if (isSidecar) {
      sidecar.push(proc);
    } else if (isChild) {
      child.push(proc);
    } else {
      main.push(proc);
    }
  }

  return { all, main, sidecar, child };
}

/**
 * Identifies orphaned Antigravity processes (sidecar/child, language_server, agy-node.cmd wrappers, resources/bin helpers).
 */
export function findAntigravityCleanupTargets(processes, antigravityExe = '', ownPid = process.pid) {
  const allList = Array.isArray(processes) ? processes : [];
  const summary = classifyAntigravityProcesses(allList);
  const installDir = String(antigravityExe || '').trim()
    ? path.dirname(String(antigravityExe).trim()).toLowerCase()
    : '';
  const installBinDir = installDir
    ? `${installDir.replace(/\//g, '\\').replace(/\\+$/, '')}\\resources\\bin\\`
    : '';

  const mainPids = summary.main
    .map((p) => Number(p.ProcessId))
    .filter((pid) => Number.isInteger(pid) && pid !== ownPid);
  const sidecarChildPids = [...summary.sidecar, ...summary.child]
    .map((p) => Number(p.ProcessId))
    .filter((pid) => Number.isInteger(pid) && pid !== ownPid);
  const sidecarChildSet = new Set(sidecarChildPids);

  const lsPids = [];
  const cmdWrapperPids = [];
  for (const proc of allList) {
    const pid = Number(proc.ProcessId);
    if (!Number.isInteger(pid) || pid === ownPid) continue;
    const nameLower = String(proc.Name || '').toLowerCase();
    const cmdLower = String(proc.CommandLine || '').toLowerCase();
    const exeLower = String(proc.ExecutablePath || '').toLowerCase();

    if (
      cmdLower.includes('desktop_app.py') ||
      (cmdLower.includes('agy-launcher') &&
        (cmdLower.includes('server.mjs') || cmdLower.includes('cli.mjs'))) ||
      nameLower.includes('agy plugin manager') ||
      nameLower.includes('agy-plugin-manager') ||
      nameLower.includes('agy dock') ||
      nameLower.includes('agy-dock')
    ) {
      continue;
    }

    if (nameLower === 'language_server.exe') {
      const isAgyLs =
        (installDir && exeLower.includes(installDir)) ||
        cmdLower.includes('\\antigravity\\resources\\bin\\language_server.exe') ||
        cmdLower.includes('/antigravity/resources/bin/language_server.exe') ||
        cmdLower.includes('--app_data_dir antigravity');
      if (isAgyLs) lsPids.push(pid);
    } else if (nameLower === 'cmd.exe' && cmdLower.includes('agy-node.cmd')) {
      cmdWrapperPids.push(pid);
    } else if (installBinDir && nameLower !== 'antigravity.exe') {
      const normExe = exeLower.replace(/\//g, '\\');
      const normCmd = cmdLower.replace(/\//g, '\\');
      if (
        (normExe.startsWith(installBinDir) || normCmd.includes(installBinDir)) &&
        !sidecarChildSet.has(pid)
      ) {
        sidecarChildSet.add(pid);
        sidecarChildPids.push(pid);
      }
    }
  }

  return {
    mainPids,
    agyNodeCmdPids: cmdWrapperPids,
    languageServerPids: lsPids,
    sidecarChildPids,
  };
}

/**
 * Parses `netstat -ano -p tcp` output and returns a Set of listening PIDs for the given port.
 */
export function parseListeningPidsForPort(netstatOutput, targetPort) {
  const pids = new Set();
  if (!netstatOutput || !targetPort) return pids;
  const portSuffix = `:${targetPort}`;
  for (const line of netstatOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toUpperCase().startsWith('TCP')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;
    const localAddr = parts[1];
    const state = parts[3].toUpperCase();
    const pid = Number.parseInt(parts[4], 10);
    if (state === 'LISTENING' && localAddr.endsWith(portSuffix) && Number.isInteger(pid)) {
      pids.add(pid);
    }
  }
  return pids;
}

const GENERIC_RUNTIMES = new Set([
  'node',
  'node.exe',
  'python',
  'python.exe',
  'pythonw',
  'pythonw.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'cmd',
  'cmd.exe',
  'wscript',
  'wscript.exe',
]);

const PLUGIN_DIR_REF_RE = /(?:^|[\\/])plugins[\\/]([a-z0-9][a-z0-9._-]{0,63})(?:[\\/]|$)/i;

/**
 * Reads optional name, version, and description metadata from a local plugin directory.
 */
export function readPluginDirManifest(pluginDir) {
  if (!pluginDir || !existsSync(pluginDir)) {
    return { name: '', version: '', description: '' };
  }
  try {
    if (!statSync(pluginDir).isDirectory()) {
      return { name: '', version: '', description: '' };
    }
  } catch {
    return { name: '', version: '', description: '' };
  }
  let name = '';
  let version = '';
  let description = '';
  for (const filename of ['package.json', 'plugin.json', 'manifest.json', 'version.json']) {
    const manifestPath = path.join(pluginDir, filename);
    if (!existsSync(manifestPath)) continue;
    try {
      const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (data && typeof data === 'object') {
        if (!version && String(data.version || '').trim()) version = String(data.version).trim();
        if (!name && String(data.name || '').trim()) name = String(data.name).trim();
        if (!description && String(data.description || '').trim()) description = String(data.description).trim();
      }
    } catch {
      // Ignore malformed manifest files
    }
  }
  if (!version) {
    const verFile = path.join(pluginDir, 'VERSION');
    if (existsSync(verFile)) {
      try {
        const firstLine = readFileSync(verFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        if (firstLine) version = firstLine;
      } catch {
        // Ignore unreadable VERSION file
      }
    }
  }
  return { name, version, description };
}

/**
 * Resolves the local plugins/<dir> folder backing a configured external plugin.
 */
export function resolvePluginDir(baseDir, plugin) {
  const pluginsRoot = path.join(baseDir, 'plugins');
  if (!plugin || !existsSync(pluginsRoot)) return null;
  const pluginId = String(plugin.id || '').trim();
  if (pluginId) {
    const direct = path.join(pluginsRoot, pluginId);
    try {
      if (existsSync(direct) && statSync(direct).isDirectory()) return direct;
    } catch {
      // Ignore stat error
    }
  }
  const tokens = [
    String(plugin.command || ''),
    ...(Array.isArray(plugin.launchArgs) ? plugin.launchArgs.map(String) : []),
    ...(Array.isArray(plugin.attachArgs) ? plugin.attachArgs.map(String) : []),
    String(plugin.processMatch || ''),
  ];
  for (const token of tokens) {
    const match = PLUGIN_DIR_REF_RE.exec(token.trim());
    if (match) {
      const candidate = path.join(pluginsRoot, match[1]);
      try {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
      } catch {
        // Ignore stat error
      }
    }
  }
  return null;
}

/**
 * Resolves plugin version from live health endpoint, config entry, or local package manifest.
 */
export function resolvePluginVersion(baseDir, plugin = null, health = null, pluginDir = null) {
  if (health && typeof health === 'object' && String(health.version || '').trim()) {
    return String(health.version).trim();
  }
  if (plugin && String(plugin.version || '').trim()) {
    return String(plugin.version).trim();
  }
  const resolvedDir = pluginDir || resolvePluginDir(baseDir, plugin);
  return readPluginDirManifest(resolvedDir).version || '';
}

/**
 * Resolves a safe process matching needle for a plugin, refusing bare generic runtimes.
 */
function resolveProcessMatchNeedle(plugin) {
  const explicit = String(plugin?.processMatch || '').trim();
  if (explicit) {
    if (GENERIC_RUNTIMES.has(path.basename(explicit).toLowerCase())) return '';
    return explicit;
  }

  const cmd = String(plugin?.command || '').trim();
  if (!cmd) return '';
  const baseCmd = path.basename(cmd).toLowerCase();
  if (!GENERIC_RUNTIMES.has(baseCmd)) {
    return cmd;
  }

  const candidateArgs = [
    ...(Array.isArray(plugin?.launchArgs) ? plugin.launchArgs : []),
    ...(Array.isArray(plugin?.attachArgs) ? plugin.attachArgs : []),
  ];
  const scriptArg = candidateArgs.find((arg) => {
    const text = String(arg || '').trim();
    return (
      text &&
      !text.startsWith('-') &&
      (/[\\/]/.test(text) || /\.(m?js|cjs|py|ps1|exe|bat|cmd)$/i.test(text))
    );
  });
  return scriptArg ? String(scriptArg).trim() : '';
}

/**
 * Matches running processes whose CommandLine contains the case-insensitive needle.
 */
export function matchPluginProcesses(processes, plugin) {
  const needle = resolveProcessMatchNeedle(plugin);
  if (!needle) return [];
  const lowerNeedle = needle.toLowerCase();
  return (processes || []).filter((proc) => {
    if (proc.ProcessId === process.pid) return false;
    const cmd = String(proc.CommandLine || '');
    return cmd.toLowerCase().includes(lowerNeedle);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, filePath);
}

function checkTcpConnect(port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function expandWinEnvVars(input, envMap = process.env) {
  return String(input || '').replace(/%([^%]+)%/g, (full, key) => {
    const matched = Object.keys(envMap).find((k) => k.toLowerCase() === key.toLowerCase());
    return matched ? String(envMap[matched]) : full;
  });
}

function extractAntigravityExePath(raw, envMap = process.env) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const expanded = expandWinEnvVars(text, envMap).trim();
  let candidate = '';
  if (expanded.startsWith('"') && expanded.indexOf('"', 1) !== -1) {
    candidate = expanded.slice(1, expanded.indexOf('"', 1));
  } else {
    const noIcon = expanded.replace(/,\s*-?\d+$/, '').trim();
    const match = /^(.*?\.exe)(?:\s|$)/i.exec(noIcon);
    candidate = match ? match[1].trim() : noIcon;
  }
  if (!candidate) return '';
  try {
    if (path.basename(candidate).toLowerCase() === 'antigravity.exe' && existsSync(candidate) && statSync(candidate).isFile()) {
      return path.resolve(candidate);
    }
  } catch {
    return '';
  }
  return '';
}

function queryAntigravityFromRegistryAndShortcutsSync(envMap = process.env) {
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @{ uninstall = @(); appPaths = @(); urlProto = @(); shortcuts = @() }
$uninstRoots = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach ($root in $uninstRoots) {
  Get-ItemProperty -Path $root | Where-Object {
    ($_.PSChildName -match 'antigravity' -or $_.DisplayName -match 'antigravity') -and
    ($_.PSChildName -notmatch 'agy-launcher|plugin[\\s_-]*manager') -and
    ($_.DisplayName -notmatch 'agy-launcher|plugin[\\s_-]*manager')
  } | ForEach-Object {
    if ($_.DisplayIcon) { $out.uninstall += [string]$_.DisplayIcon }
    if ($_.InstallLocation) { $out.uninstall += (Join-Path ([string]$_.InstallLocation) 'Antigravity.exe') }
    if ($_.UninstallString) { $out.uninstall += [string]$_.UninstallString }
  }
}
foreach ($ap in @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Antigravity.exe',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Antigravity.exe'
)) {
  $p = Get-ItemProperty -Path $ap
  if ($p.'(default)') { $out.appPaths += [string]$p.'(default)' }
  if ($p.Path) { $out.appPaths += (Join-Path ([string]$p.Path) 'Antigravity.exe') }
}
foreach ($up in @(
  'HKCU:\\Software\\Classes\\antigravity\\shell\\open\\command',
  'HKLM:\\Software\\Classes\\antigravity\\shell\\open\\command'
)) {
  $p = Get-ItemProperty -Path $up
  if ($p.'(default)') { $out.urlProto += [string]$p.'(default)' }
}
$out | ConvertTo-Json -Compress
`;
  try {
    const stdout = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { windowsHide: true, encoding: 'utf8', timeout: 5000 }
    ).trim();
    if (!stdout) return { found: false, path: '', source: '' };
    const parsed = JSON.parse(stdout);
    const asArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    for (const raw of asArr(parsed.uninstall)) {
      const hit = extractAntigravityExePath(raw, envMap);
      if (hit) return { found: true, path: hit, source: 'registry-uninstall' };
    }
    for (const raw of asArr(parsed.appPaths)) {
      const hit = extractAntigravityExePath(raw, envMap);
      if (hit) return { found: true, path: hit, source: 'registry-app-paths' };
    }
    for (const raw of asArr(parsed.urlProto)) {
      const hit = extractAntigravityExePath(raw, envMap);
      if (hit) return { found: true, path: hit, source: 'registry-url-protocol' };
    }
  } catch {
    // Ignore registry probe failures
  }
  return { found: false, path: '', source: '' };
}

function detectAntigravityFromShortcutsSync(envMap = process.env) {
  const desktopDirs = [
    'D:\\Desktop',
    path.join(os.homedir(), 'Desktop'),
    envMap.PUBLIC ? path.join(envMap.PUBLIC, 'Desktop') : '',
    path.join(envMap.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    envMap.ProgramData ? path.join(envMap.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
  ].filter(Boolean);

  const lnks = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3 || !existsSync(dir)) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (
          entry.name.toLowerCase().endsWith('.lnk') &&
          entry.name.toLowerCase().includes('antigravity') &&
          !ANTIGRAVITY_INSTALLER_SKIP_RE.test(entry.name)
        ) {
          lnks.push(full);
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  };
  for (const d of desktopDirs) walk(d);
  if (lnks.length === 0) return '';

  const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const psScript =
    `$wsh = New-Object -ComObject WScript.Shell; ` +
    `@(${lnks.slice(0, 12).map(psQuote).join(', ')}) | ForEach-Object { try { $wsh.CreateShortcut($_).TargetPath } catch {} }`;
  try {
    const stdout = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { windowsHide: true, encoding: 'utf8', timeout: 5000 }
    );
    for (const line of stdout.split(/\r?\n/)) {
      const hit = extractAntigravityExePath(line, envMap);
      if (hit) return hit;
    }
  } catch {
    // Ignore shortcut probe failures
  }
  return '';
}

/**
 * Detects installed Antigravity.exe across running processes, Windows Registry, standard paths, and shortcuts.
 */
export function detectAntigravityExe(options = {}) {
  const envMap = options.env || process.env;
  const checkRegistry = options.checkRegistry !== false;
  const checkShortcuts = options.checkShortcuts !== false;

  // (a) Running Antigravity.exe process ExecutablePath
  if (Array.isArray(options.processes)) {
    for (const proc of options.processes) {
      if (String(proc?.Name || '').toLowerCase() !== 'antigravity.exe') continue;
      const cand = extractAntigravityExePath(proc.ExecutablePath || proc.CommandLine, envMap);
      if (cand) return { found: true, path: cand, source: 'running-process' };
    }
  } else {
    try {
      const stdout = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | Select-Object -ExpandProperty ExecutablePath -First 1",
        ],
        { windowsHide: true, encoding: 'utf8', timeout: 6000 }
      );
      for (const line of stdout.split(/\r?\n/)) {
        const cand = extractAntigravityExePath(line, envMap);
        if (cand) return { found: true, path: cand, source: 'running-process' };
      }
    } catch {
      // Ignore process probe errors
    }
  }

  // (b) Windows Registry
  if (checkRegistry) {
    const regHit = queryAntigravityFromRegistryAndShortcutsSync(envMap);
    if (regHit.found) return regHit;
  }

  // (c) Standard install paths
  const localApp = envMap.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const progFiles = envMap.ProgramFiles || 'C:\\Program Files';
  const progX86 = envMap['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const standardCandidates = [
    path.join(localApp, 'Programs', 'antigravity', 'Antigravity.exe'),
    path.join(localApp, 'Programs', 'Antigravity', 'Antigravity.exe'),
    path.join(progFiles, 'Antigravity', 'Antigravity.exe'),
    path.join(progX86, 'Antigravity', 'Antigravity.exe'),
  ];
  for (const cand of standardCandidates) {
    try {
      if (existsSync(cand) && statSync(cand).isFile()) {
        return { found: true, path: path.resolve(cand), source: 'standard-path' };
      }
    } catch {
      // Ignore stat error
    }
  }

  // (d) Desktop / Start Menu shortcuts
  if (checkShortcuts) {
    const lnkHit = detectAntigravityFromShortcutsSync(envMap);
    if (lnkHit) return { found: true, path: lnkHit, source: 'shortcut' };
  }

  return { found: false, path: '', source: '' };
}

function normalizeProxyOverride(rawOverride) {
  const text = String(rawOverride || '').trim();
  if (!text) return DEFAULT_NO_PROXY;
  const parts = [];
  const seen = new Set();
  for (const base of DEFAULT_NO_PROXY.split(',')) {
    seen.add(base.toLowerCase());
    parts.push(base);
  }
  for (const rawItem of text.split(/[;,]+/)) {
    const item = rawItem.trim();
    if (!item || item.toLowerCase() === '<local>') continue;
    if (!seen.has(item.toLowerCase())) {
      seen.add(item.toLowerCase());
      parts.push(item);
    }
  }
  return parts.join(',');
}

function ensureProxyScheme(addr, defaultScheme = 'http') {
  const clean = String(addr || '').trim();
  if (!clean) return '';
  return clean.includes('://') ? clean : `${defaultScheme}://${clean}`;
}

function parseWindowsProxyServer(proxyServer, proxyOverride = '') {
  const raw = String(proxyServer || '').trim();
  if (!raw) {
    return { httpProxy: '', httpsProxy: '', allProxy: '', noProxy: '', electronProxyServer: '' };
  }
  const noProxy = normalizeProxyOverride(proxyOverride);
  let httpProxy = '';
  let httpsProxy = '';
  let allProxy = '';
  let electronProxy = '';

  if (raw.includes('=')) {
    for (const seg of raw.split(';')) {
      const eqIdx = seg.indexOf('=');
      if (eqIdx === -1) continue;
      const proto = seg.slice(0, eqIdx).trim().toLowerCase();
      const val = seg.slice(eqIdx + 1).trim();
      if (!val) continue;
      if (proto === 'http') httpProxy = ensureProxyScheme(val, 'http');
      else if (proto === 'https') httpsProxy = ensureProxyScheme(val, 'http');
      else if (proto === 'socks' || proto === 'socks5' || proto === 'socks4') {
        allProxy = ensureProxyScheme(val, 'socks5');
      }
    }
    if (httpProxy && !httpsProxy) httpsProxy = httpProxy;
    else if (httpsProxy && !httpProxy) httpProxy = httpsProxy;
    electronProxy = allProxy || httpsProxy || httpProxy;
  } else {
    const portMatch = /:(\d+)$/.exec(raw);
    const portNum = portMatch ? Number.parseInt(portMatch[1], 10) : 0;
    if (SOCKS_ONLY_PORTS.has(portNum)) {
      allProxy = ensureProxyScheme(raw, 'socks5');
      electronProxy = allProxy;
    } else if (MIXED_PROXY_PORTS.has(portNum)) {
      httpProxy = ensureProxyScheme(raw, 'http');
      httpsProxy = httpProxy;
      allProxy = ensureProxyScheme(raw, 'socks5');
      electronProxy = httpProxy;
    } else {
      httpProxy = ensureProxyScheme(raw, 'http');
      httpsProxy = httpProxy;
      allProxy = httpProxy;
      electronProxy = httpProxy;
    }
  }

  return {
    httpProxy,
    httpsProxy,
    allProxy,
    noProxy,
    electronProxyServer: electronProxy,
  };
}

function buildProxyUrlsFromPorts(openPorts) {
  const portSet = new Set(openPorts);
  let httpProxy = '';
  let httpsProxy = '';
  let allProxy = '';
  let electronProxy = '';

  for (const mixedPort of [7897, 7890]) {
    if (portSet.has(mixedPort)) {
      httpProxy = `http://127.0.0.1:${mixedPort}`;
      httpsProxy = httpProxy;
      allProxy = `socks5://127.0.0.1:${mixedPort}`;
      electronProxy = httpProxy;
      break;
    }
  }

  if (!httpProxy && portSet.has(10809)) {
    httpProxy = 'http://127.0.0.1:10809';
    httpsProxy = httpProxy;
    electronProxy = httpProxy;
  }
  if (!allProxy && portSet.has(10808)) {
    allProxy = 'socks5://127.0.0.1:10808';
    if (!electronProxy) electronProxy = allProxy;
  }

  if (!httpProxy && !allProxy) {
    const firstPort = openPorts[0];
    if (SOCKS_ONLY_PORTS.has(firstPort)) {
      allProxy = `socks5://127.0.0.1:${firstPort}`;
      electronProxy = allProxy;
      if (firstPort === 2080) {
        httpProxy = `http://127.0.0.1:${firstPort}`;
        httpsProxy = httpProxy;
      }
    } else {
      httpProxy = `http://127.0.0.1:${firstPort}`;
      httpsProxy = httpProxy;
      allProxy = httpProxy;
      electronProxy = httpProxy;
    }
  }

  return {
    httpProxy,
    httpsProxy,
    allProxy,
    noProxy: DEFAULT_NO_PROXY,
    electronProxyServer: electronProxy || httpsProxy || httpProxy || allProxy,
  };
}

function readInternetSettingsRegistry() {
  const psScript =
    "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' " +
    '-ErrorAction SilentlyContinue | Select-Object ProxyEnable,ProxyServer,ProxyOverride,AutoConfigURL | ConvertTo-Json -Compress';
  try {
    const stdout = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { windowsHide: true, encoding: 'utf8', timeout: 4000 }
    ).trim();
    return stdout ? JSON.parse(stdout) : null;
  } catch {
    return null;
  }
}

/**
 * Inspects Windows Registry Internet Settings, proxy env vars, and active local proxy processes/ports.
 */
export async function detectSystemProxy(options = {}) {
  const empty = {
    detected: false,
    source: '',
    processName: '',
    httpProxy: '',
    httpsProxy: '',
    allProxy: '',
    noProxy: '',
    electronProxyServer: '',
  };

  // (a) Windows Registry Internet Settings
  const reg = options.registrySettings !== undefined ? options.registrySettings : readInternetSettingsRegistry();
  if (reg && typeof reg === 'object') {
    const proxyEnabled = Number(reg.ProxyEnable || 0) === 1;
    const proxyServer = String(reg.ProxyServer || '').trim();
    if (proxyEnabled && proxyServer) {
      const parsed = parseWindowsProxyServer(proxyServer, reg.ProxyOverride || '');
      if (parsed.httpProxy || parsed.httpsProxy || parsed.allProxy) {
        return { detected: true, source: 'windows-registry', processName: '', ...parsed };
      }
    }
  }

  // (b) Environment variables
  const envMap = options.env || process.env;
  const envHttp = String(envMap.HTTP_PROXY || envMap.http_proxy || '').trim();
  const envHttps = String(envMap.HTTPS_PROXY || envMap.https_proxy || '').trim();
  const envAll = String(envMap.ALL_PROXY || envMap.all_proxy || '').trim();
  const envNo = String(envMap.NO_PROXY || envMap.no_proxy || '').trim();
  if (envHttp || envHttps || envAll) {
    const httpProxy = envHttp || envHttps;
    const httpsProxy = envHttps || envHttp;
    return {
      detected: true,
      source: 'env',
      processName: '',
      httpProxy,
      httpsProxy,
      allProxy: envAll,
      noProxy: envNo || DEFAULT_NO_PROXY,
      electronProxyServer: envAll || httpsProxy || httpProxy,
    };
  }

  // (c) Running proxy processes + loopback TCP reachability
  let procList = options.processes;
  if (!Array.isArray(procList)) {
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
            'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
        ],
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 8000 }
      );
      const trimmed = stdout.trim();
      const parsed = trimmed ? JSON.parse(trimmed) : [];
      procList = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      procList = [];
    }
  }

  let processName = '';
  for (const proc of procList) {
    const name = String(proc?.Name || '').trim();
    const cmd = String(proc?.CommandLine || '');
    const haystack = `${name} ${cmd}`.toLowerCase();
    const matched = PROXY_PROCESS_NAMES.find((needle) => haystack.includes(needle));
    if (matched) {
      processName = name || matched;
      break;
    }
  }

  let openPorts = Array.isArray(options.openPorts)
    ? [...options.openPorts]
    : (
        await Promise.all(
          COMMON_PROXY_PORTS.map(async (port) => ((await checkTcpConnect(port, 200)) ? port : null))
        )
      ).filter((p) => p !== null);

  if (!processName) {
    openPorts = openPorts.filter((p) => p !== 8080);
  }
  if (openPorts.length > 0) {
    const urls = buildProxyUrlsFromPorts(openPorts);
    return {
      detected: true,
      source: processName ? 'process+port' : 'loopback-port',
      processName,
      ...urls,
    };
  }

  return empty;
}

function validateZipMemberName(rawName) {
  const name = String(rawName || '');
  if (!name || name.includes('\0')) {
    throw new Error(`非法的压缩包路径: ${JSON.stringify(rawName)}`);
  }
  if (name.startsWith('/') || name.startsWith('\\')) {
    throw new Error(`检测到非法绝对路径 (Zip-Slip): ${name}`);
  }
  if (/^[A-Za-z]:/.test(name)) {
    throw new Error(`检测到非法驱动器路径 (Zip-Slip): ${name}`);
  }
  const parts = name.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((part) => part === '..') || (parts[0] && parts[0].includes(':'))) {
    throw new Error(`检测到路径穿越 (Zip-Slip): ${name}`);
  }
  return parts.join('/');
}

function readZipEntries(zipBuffer) {
  let eocdOffset = -1;
  const minOffset = Math.max(0, zipBuffer.length - 65557);
  for (let i = zipBuffer.length - 22; i >= minOffset; i -= 1) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('无效的 ZIP 插件包（未找到中央目录）');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (pos + 46 > zipBuffer.length || zipBuffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('无效的 ZIP 中央目录记录');
    }
    const flags = zipBuffer.readUInt16LE(pos + 8);
    const method = zipBuffer.readUInt16LE(pos + 10);
    const compressedSize = zipBuffer.readUInt32LE(pos + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(pos + 24);
    const nameLen = zipBuffer.readUInt16LE(pos + 28);
    const extraLen = zipBuffer.readUInt16LE(pos + 30);
    const commentLen = zipBuffer.readUInt16LE(pos + 32);
    const externalAttr = zipBuffer.readUInt32LE(pos + 38);
    const localOffset = zipBuffer.readUInt32LE(pos + 42);

    const rawName = zipBuffer.subarray(pos + 46, pos + 46 + nameLen).toString(flags & 0x0800 ? 'utf8' : 'utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    if (((externalAttr >>> 16) & 0o170000) === 0o120000) {
      throw new Error(`拒绝包含符号链接的压缩包条目: ${rawName}`);
    }

    const isDir = rawName.endsWith('/') || rawName.endsWith('\\');
    const cleanRel = validateZipMemberName(rawName);
    if (!cleanRel) continue;

    if (localOffset + 30 > zipBuffer.length || zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`无效的 ZIP 本地文件头: ${rawName}`);
    }
    const lfNameLen = zipBuffer.readUInt16LE(localOffset + 26);
    const lfExtraLen = zipBuffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lfNameLen + lfExtraLen;
    const compressedSlice = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    let data = Buffer.alloc(0);
    if (!isDir) {
      if (method === 0) {
        data = Buffer.from(compressedSlice);
      } else if (method === 8) {
        data = inflateRawSync(compressedSlice);
      } else {
        throw new Error(`不支持的 ZIP 压缩方式 (${method}): ${rawName}`);
      }
      if (data.length !== uncompressedSize) {
        throw new Error(`ZIP 条目解压长度校验失败: ${rawName}`);
      }
    }

    entries.push({ rel: cleanRel, isDir, data });
  }
  return entries;
}

function normalizePluginPackageManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('agy-plugin.json 必须为 JSON 对象');
  }
  const schemaVersion = manifest.schemaVersion ?? 1;
  if (Number(schemaVersion) !== 1) {
    throw new Error(`不支持的插件包 schemaVersion: ${schemaVersion}`);
  }
  const id = String(manifest.id || '').trim();
  if (!isValidPluginId(id)) {
    throw new Error('插件包 id 仅允许字母、数字、点号、连字符和下划线（长度 2-64，不能以点号结尾或含 ..）');
  }
  const command = String(manifest.command || '').trim();
  if (!command) {
    throw new Error('插件包 agy-plugin.json 缺少 command 字段');
  }

  const toStrList = (val) => (Array.isArray(val) ? val.map((x) => String(x)).filter((s) => s.trim()) : []);
  const launchArgs = toStrList(manifest.launchArgs);
  const attachArgsRaw = toStrList(manifest.attachArgs);
  const attachArgs = attachArgsRaw.length > 0 ? attachArgsRaw : [...launchArgs];
  const stopArgs = toStrList(manifest.stopArgs);

  const entry = {
    id,
    name: String(manifest.name || id).trim(),
    description: String(manifest.description || '').trim(),
    enabled: manifest.enabled !== false,
    autoAttach: manifest.autoAttach !== false,
    type: String(manifest.type || 'custom-cdp').trim(),
    command,
    launchArgs,
    attachArgs,
    stopArgs,
  };
  if (String(manifest.version || '').trim()) entry.version = String(manifest.version).trim();
  if (String(manifest.healthUrl || '').trim()) entry.healthUrl = String(manifest.healthUrl).trim();
  if (String(manifest.processMatch || '').trim()) entry.processMatch = String(manifest.processMatch).trim();

  if (!resolveProcessMatchNeedle(entry)) {
    throw new Error('插件包缺少安全的 processMatch 或脚本路径，禁止使用裸通用运行时');
  }
  return entry;
}

export class AgyProcessManager {
  constructor(options = {}) {
    const envDataDir = String(process.env.AGY_MANAGER_DATA_DIR || '').trim();
    this.baseDir = options.baseDir
      ? path.resolve(options.baseDir)
      : options.dataDir
        ? path.resolve(options.dataDir)
        : envDataDir
          ? path.resolve(envDataDir)
          : DEFAULT_BASE_DIR;
    this.dataDir = this.baseDir;
    this.assetsDir = options.assetsDir ? path.resolve(options.assetsDir) : DEFAULT_BASE_DIR;
    this.pluginsDir = path.join(this.dataDir, 'plugins');
    this.configPath = path.join(this.dataDir, 'plugins.json');
    this.logsDir = path.join(this.dataDir, 'logs');
    this.launcherLogPath = path.join(this.logsDir, 'launcher.log');
    this.launchLockPath = path.join(this.logsDir, '.launch.lock');
    this.appDataDir = options.appDataDir || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    this.geminiPluginsDir =
      options.geminiPluginsDir || path.join(os.homedir(), '.gemini', 'config', 'plugins');
    this.geminiConfigPath =
      options.geminiConfigPath || path.join(os.homedir(), '.gemini', 'config', 'config.json');
    this._antigravityDetectAttempted = false;
    mkdirSync(this.logsDir, { recursive: true });
  }

  log(message, level = 'INFO') {
    const line = `[${formatTimestamp()}] [${level}] ${message}`;
    mkdirSync(this.logsDir, { recursive: true });
    appendFileSync(this.launcherLogPath, `${line}\n`, 'utf8');
    return line;
  }

  _buildDefaultConfig() {
    const examplePath = path.join(this.assetsDir, 'plugins.example.json');
    if (existsSync(examplePath)) {
      try {
        const parsed = JSON.parse(readFileSync(examplePath, 'utf8').replace(/^\uFEFF/, ''));
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {
        // Fallback to clean template
      }
    }
    return {
      managerPort: 12400,
      antigravityExe: '',
      antigravityArgs: [],
      cdpWaitTimeoutSec: 30,
      proxy: {
        enabled: false,
        httpProxy: '',
        httpsProxy: '',
        allProxy: '',
        noProxy: DEFAULT_NO_PROXY,
        electronProxyServer: '',
      },
      lifecycle: { autoCleanupOnExit: true, stopPluginsOnExit: true },
      plugins: [],
      ui: { theme: 'auto', minimizeToTray: true },
    };
  }

  loadConfig() {
    let parsed;
    if (!existsSync(this.configPath)) {
      parsed = this._buildDefaultConfig();
      this.saveConfig(parsed);
    } else {
      const raw = readFileSync(this.configPath, 'utf8').replace(/^\uFEFF/, '');
      parsed = JSON.parse(raw);
    }
    if (!Array.isArray(parsed.plugins)) parsed.plugins = [];
    if (!parsed.proxy || typeof parsed.proxy !== 'object') {
      parsed.proxy = { enabled: false };
    }
    if (!parsed.lifecycle || typeof parsed.lifecycle !== 'object') {
      parsed.lifecycle = { autoCleanupOnExit: true, stopPluginsOnExit: true };
    } else {
      parsed.lifecycle = {
        autoCleanupOnExit: parsed.lifecycle.autoCleanupOnExit !== false,
        stopPluginsOnExit: parsed.lifecycle.stopPluginsOnExit !== false,
      };
    }
    const exe = String(parsed.antigravityExe || '').trim();
    if (!exe || !existsSync(exe)) {
      if (!this._antigravityDetectAttempted) {
        this._antigravityDetectAttempted = true;
        const detected = this.detectAntigravity();
        this._detectedAntigravityExe = detected.found && detected.path ? detected.path : '';
        if (this._detectedAntigravityExe && !exe) {
          parsed.antigravityExe = this._detectedAntigravityExe;
          try {
            this.saveConfig(parsed);
          } catch {
            // Ignore persistence failure during read
          }
        }
      }
      if (this._detectedAntigravityExe) {
        parsed.antigravityExe = this._detectedAntigravityExe;
      }
    }
    return parsed;
  }

  saveConfig(config) {
    writeJsonAtomic(this.configPath, config);
    return config;
  }

  detectAntigravity(processes = null) {
    return detectAntigravityExe(Array.isArray(processes) ? { processes } : {});
  }

  saveAntigravityExe(exePath) {
    const cleaned = String(exePath || '').trim();
    const config = this.loadConfig();
    config.antigravityExe = cleaned;
    this.saveConfig(config);
    this.log(`已更新 Antigravity 客户端路径: ${cleaned || '(空)'}`);
    return {
      antigravityExe: cleaned,
      exists: Boolean(cleaned && existsSync(cleaned)),
    };
  }

  async detectSystemProxy() {
    return detectSystemProxy();
  }

  async autoDetectAndSaveProxy() {
    const detection = await this.detectSystemProxy();
    if (detection.detected) {
      const savedProxy = this.saveProxyConfig({
        enabled: true,
        httpProxy: detection.httpProxy,
        httpsProxy: detection.httpsProxy,
        allProxy: detection.allProxy,
        noProxy: detection.noProxy || DEFAULT_NO_PROXY,
        electronProxyServer: detection.electronProxyServer,
      });
      return {
        detected: true,
        saved: true,
        detection,
        proxy: savedProxy,
      };
    }
    return {
      detected: false,
      saved: false,
      detection,
      proxy: this.loadConfig().proxy || { enabled: false },
    };
  }

  resolveCommandWithEnv(command, antigravityExe = '') {
    const cmd = String(command || '').trim();
    if (!cmd) throw new Error('插件启动命令不能为空');
    if (path.isAbsolute(cmd)) return { cmd, extraEnv: {} };
    if (cmd.includes('\\') || cmd.includes('/') || /\.(cmd|bat|ps1)$/i.test(cmd)) {
      return { cmd: path.resolve(this.baseDir, cmd), extraEnv: {} };
    }
    if (cmd.toLowerCase() === 'node' || cmd.toLowerCase() === 'node.exe') {
      const agy = String(antigravityExe || '').trim();
      const hasNodeOnPath = process.execPath && /node(?:\.exe)?$/i.test(process.execPath) && existsSync(process.execPath);
      if (hasNodeOnPath) return { cmd: process.execPath, extraEnv: {} };
      if (agy && existsSync(agy)) return { cmd: agy, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
      return { cmd, extraEnv: {} };
    }
    if (/\.exe$/i.test(cmd)) {
      return { cmd: path.resolve(this.baseDir, cmd), extraEnv: {} };
    }
    return { cmd, extraEnv: {} };
  }

  resolveCommand(command) {
    return this.resolveCommandWithEnv(command).cmd;
  }

  getPluginArgs(plugin, mode = 'attach') {
    if (mode === 'launch' && Array.isArray(plugin.launchArgs)) return [...plugin.launchArgs];
    if (mode === 'attach' && Array.isArray(plugin.attachArgs)) return [...plugin.attachArgs];
    if (Array.isArray(plugin.args)) return [...plugin.args];
    return [];
  }

  async listProcesses() {
    const psScript =
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,WorkingSetSize | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  async isPortOwnedAndListening(port, allowedPids) {
    if (!port) return false;
    try {
      const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      });
      const listeningPids = parseListeningPidsForPort(stdout, port);
      if (listeningPids.size === 0) return false;
      if (allowedPids.length === 0) return true;
      return allowedPids.some((pid) => listeningPids.has(pid));
    } catch {
      return checkTcpConnect(port);
    }
  }

  async getActiveCdpInfo(procList = null) {
    const processes = procList || (await this.listProcesses());
    const summary = classifyAntigravityProcesses(processes);
    const devToolsFile = path.join(this.appDataDir, 'Antigravity', 'DevToolsActivePort');
    const allCount = summary.all.length;
    const mainCount = summary.main.length;
    const sidecarCount = summary.sidecar.length;
    const childCount = summary.child.length;

    const base = {
      ready: false,
      port: null,
      wsPath: null,
      fileExists: existsSync(devToolsFile),
      processCount: allCount,
      mainProcessCount: mainCount,
      sidecarProcessCount: sidecarCount,
      childProcessCount: childCount,
      mainPids: summary.main.map((p) => p.ProcessId),
      reason: '',
    };

    if (allCount === 0) {
      return { ...base, reason: 'Antigravity.exe 未运行' };
    }
    if (mainCount === 0) {
      return { ...base, reason: `仅检测到 ${sidecarCount} 个后台/Sidecar 进程，主程序未运行` };
    }
    if (!base.fileExists) {
      return { ...base, reason: 'DevToolsActivePort 文件尚未生成' };
    }

    const parsed = parseDevToolsActivePort(readFileSync(devToolsFile, 'utf8'));
    if (!parsed) {
      return { ...base, reason: 'DevToolsActivePort 内容为空或端口无效' };
    }

    const listening = await this.isPortOwnedAndListening(parsed.port, base.mainPids);
    return {
      ...base,
      ready: listening,
      port: parsed.port,
      wsPath: parsed.wsPath,
      reason: listening
        ? 'OK'
        : `端口 ${parsed.port} 尚未被运行中的 Antigravity.exe 主进程监听（可能为残留文件）`,
    };
  }

  async fetchHealth(healthUrl) {
    if (!healthUrl) return null;
    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  getPluginLogInfo(id) {
    const outPath = path.join(this.logsDir, `${id}.out.log`);
    const errPath = path.join(this.logsDir, `${id}.err.log`);
    return {
      outLog: outPath,
      errLog: errPath,
      outBytes: existsSync(outPath) ? statSync(outPath).size : 0,
      errBytes: existsSync(errPath) ? statSync(errPath).size : 0,
    };
  }

  async getOverview() {
    const config = this.loadConfig();
    const processes = await this.listProcesses();
    const cdp = await this.getActiveCdpInfo(processes);
    const installDir = config.antigravityExe ? path.dirname(config.antigravityExe) : '';
    const versionDllExists = installDir ? existsSync(path.join(installDir, 'version.dll')) : false;

    const procByPid = new Map();
    const childrenMap = new Map();
    for (const proc of processes || []) {
      const pid = Number(proc?.ProcessId);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      procByPid.set(pid, proc);
      const ppid = Number(proc?.ParentProcessId);
      if (Number.isFinite(ppid) && ppid > 0) {
        if (!childrenMap.has(ppid)) childrenMap.set(ppid, []);
        childrenMap.get(ppid).push(pid);
      }
    }

    const sumTreeMemory = (matchedProcs) => {
      const treePids = new Set();
      const queue = [];
      for (const proc of matchedProcs || []) {
        const pid = Number(proc?.ProcessId);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        if (!procByPid.has(pid)) procByPid.set(pid, proc);
        if (!treePids.has(pid)) {
          treePids.add(pid);
          queue.push(pid);
        }
      }
      while (queue.length > 0) {
        const cur = queue.shift();
        for (const childPid of childrenMap.get(cur) || []) {
          if (treePids.has(childPid)) continue;
          const childProc = procByPid.get(childPid);
          if (
            childProc &&
            String(childProc.Name || '').toLowerCase() === 'antigravity.exe' &&
            !isManagedPluginRuntimeProcess(childProc)
          ) {
            continue;
          }
          treePids.add(childPid);
          queue.push(childPid);
        }
      }
      let memBytes = 0;
      for (const pid of treePids) {
        const ws = Number(procByPid.get(pid)?.WorkingSetSize || 0);
        if (Number.isFinite(ws) && ws > 0) memBytes += ws;
      }
      return { memBytes, treePids };
    };

    const totalPluginPids = new Set();
    const plugins = await Promise.all(
      config.plugins.map(async (plugin) => {
        const matchedProcs = matchPluginProcesses(processes, plugin);
        const health = await this.fetchHealth(plugin.healthUrl);
        const pids = matchedProcs.map((p) => p.ProcessId);
        const { memBytes, treePids } = sumTreeMemory(matchedProcs);
        for (const pid of treePids) totalPluginPids.add(pid);
        const cmdPath = this.resolveCommand(plugin.command);
        const executableExists =
          !cmdPath.includes(path.sep) && !/\.(exe|cmd|bat|ps1)$/i.test(cmdPath)
            ? true
            : existsSync(cmdPath);

        return {
          ...plugin,
          version: resolvePluginVersion(this.baseDir, plugin, health),
          running: pids.length > 0 || Boolean(health),
          pids,
          memoryBytes: memBytes,
          health,
          executableExists,
          logs: this.getPluginLogInfo(plugin.id),
        };
      })
    );

    let totalPluginMemoryBytes = 0;
    for (const pid of totalPluginPids) {
      const ws = Number(procByPid.get(pid)?.WorkingSetSize || 0);
      if (Number.isFinite(ws) && ws > 0) totalPluginMemoryBytes += ws;
    }

    return {
      timestamp: new Date().toISOString(),
      baseDir: this.baseDir,
      dataDir: this.dataDir,
      assetsDir: this.assetsDir,
      pluginsDir: this.pluginsDir,
      antigravityExe: config.antigravityExe,
      antigravityExists: config.antigravityExe ? existsSync(config.antigravityExe) : false,
      versionDllExists,
      cdp,
      proxy: config.proxy,
      lifecycle: config.lifecycle,
      totalPluginMemoryBytes,
      runningPluginProcessCount: totalPluginPids.size,
      plugins,
    };
  }

  acquireLaunchLock() {
    mkdirSync(this.logsDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.launchLockPath, 'wx');
        writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, 'utf8');
        closeSync(fd);
        return true;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        try {
          const content = readFileSync(this.launchLockPath, 'utf8');
          const holderPid = Number.parseInt(content.split(/\r?\n/)[0] || '', 10);
          if (!isPidAlive(holderPid)) {
            unlinkSync(this.launchLockPath);
            continue;
          }
        } catch {
          return false;
        }
        return false;
      }
    }
    return false;
  }

  releaseLaunchLock() {
    try {
      if (existsSync(this.launchLockPath)) unlinkSync(this.launchLockPath);
    } catch {
      // Ignore cleanup errors
    }
  }

  async focusAntigravityWindow(pids = []) {
    if (!Array.isArray(pids) || pids.length === 0) return false;
    const pidList = pids.filter((n) => Number.isInteger(n) && n > 0).join(',');
    if (!pidList) return false;
    const psScript = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinFocus {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
foreach ($proc in (Get-Process -Id ${pidList} -ErrorAction SilentlyContinue)) {
  if ($proc.MainWindowHandle -ne 0) {
    if ([WinFocus]::IsIconic($proc.MainWindowHandle)) {
      [WinFocus]::ShowWindowAsync($proc.MainWindowHandle, 9) | Out-Null
    }
    [WinFocus]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
  }
}
`;
    try {
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
        { windowsHide: true, timeout: 5000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  async launchAntigravityAndAttach({ focusIfRunning = false } = {}) {
    if (!this.acquireLaunchLock()) {
      const msg = '已有另一个 AGY Dock 启动流程正在执行，跳过重复触发';
      this.log(msg);
      return { skipped: true, message: msg, overview: await this.getOverview() };
    }

    try {
      const config = this.loadConfig();
      const initialCdp = await this.getActiveCdpInfo();

      if (initialCdp.ready) {
        this.log(
          `检测到 Antigravity 主程序已在运行且 CDP 就绪 (127.0.0.1:${initialCdp.port})，直接执行热附着`
        );
        if (focusIfRunning) {
          await this.focusAntigravityWindow(initialCdp.mainPids);
        }
      } else {
        if (initialCdp.sidecarProcessCount > 0 && initialCdp.mainProcessCount === 0) {
          this.log(
            `检测到 ${initialCdp.sidecarProcessCount} 个后台 Sidecar 进程（主程序未运行），正常拉起 Antigravity.exe`
          );
        } else if (initialCdp.mainProcessCount > 0) {
          this.log(`检测到主进程存在但 CDP 未就绪 (${initialCdp.reason})，尝试拉起/唤醒 Antigravity.exe`);
        }

        const exe = String(config.antigravityExe || '');
        if (!exe || !existsSync(exe)) {
          throw new Error(`未找到 Antigravity 客户端: ${exe}`);
        }

        const { agyArgs, env, proxyInjected } = buildAntigravityLaunchParams(config);
        if (proxyInjected) {
          this.log('已按配置注入代理参数 (含 NO_PROXY) 启动 Antigravity.exe');
        } else {
          this.log('按默认代理设置 (proxy.enabled=false) 启动 Antigravity.exe');
        }

        const child = spawn(exe, agyArgs, {
          cwd: path.dirname(exe),
          env,
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      }

      const timeoutSec = Number(config.cdpWaitTimeoutSec) || 30;
      const deadline = Date.now() + timeoutSec * 1000;
      let cdp = null;
      while (Date.now() < deadline) {
        cdp = await this.getActiveCdpInfo();
        if (cdp.ready) break;
        await sleep(500);
      }

      if (!cdp || !cdp.ready) {
        const reason = cdp?.reason || '未知原因';
        this.log(`等待 CDP 端口就绪超时 (${timeoutSec}s): ${reason}`, 'ERROR');
        throw new Error(`CDP 端口未就绪: ${reason}`);
      }

      this.log(`CDP 端口已就绪并验证 Listen: 127.0.0.1:${cdp.port}`);
      const results = [];
      for (const plugin of config.plugins) {
        if (!plugin.enabled || plugin.autoAttach === false) {
          this.log(`跳过插件: ${plugin.id} (enabled=${Boolean(plugin.enabled)}, autoAttach=${plugin.autoAttach !== false})`);
          continue;
        }
        try {
          results.push(await this.startPlugin(plugin.id, 'launch'));
        } catch (err) {
          this.log(`启动插件 ${plugin.id} 失败: ${err.message}`, 'ERROR');
          results.push({ id: plugin.id, status: 'error', error: err.message });
        }
      }

      return { skipped: false, cdp, results, overview: await this.getOverview() };
    } finally {
      this.releaseLaunchLock();
    }
  }

  async attachEnabledPlugins() {
    const cdp = await this.getActiveCdpInfo();
    if (!cdp.ready) {
      this.log(`无法热附着: ${cdp.reason}`, 'ERROR');
      throw new Error(`当前未检测到有效的运行中 Antigravity CDP 端口 (${cdp.reason})`);
    }
    this.log(`检测到运行中的 Antigravity CDP 端口 127.0.0.1:${cdp.port} (Listen 已确认)`);
    const config = this.loadConfig();
    const results = [];
    for (const plugin of config.plugins) {
      if (!plugin.enabled) {
        this.log(`跳过已禁用插件: ${plugin.id}`);
        continue;
      }
      try {
        results.push(await this.startPlugin(plugin.id, 'attach'));
      } catch (err) {
        this.log(`启动插件 ${plugin.id} 失败: ${err.message}`, 'ERROR');
        results.push({ id: plugin.id, status: 'error', error: err.message });
      }
    }
    return { cdp, results, overview: await this.getOverview() };
  }

  async startPlugin(id, mode = 'attach') {
    const config = this.loadConfig();
    const plugin = config.plugins.find((p) => p.id === id);
    if (!plugin) throw new Error(`未找到插件: ${id}`);

    const { cmd, extraEnv } = this.resolveCommandWithEnv(plugin.command, config.antigravityExe || '');
    if ((cmd.includes(path.sep) || /\.(exe|cmd|bat|ps1)$/i.test(cmd)) && !existsSync(cmd)) {
      const msg = `插件可执行文件不存在，跳过 ${plugin.id}: ${cmd}`;
      this.log(msg, 'ERROR');
      return { id: plugin.id, status: 'missing', message: msg };
    }

    const health = await this.fetchHealth(plugin.healthUrl);
    if (health) {
      const msg = `插件 ${plugin.id} 已存活 (health OK, attachedPages=${health.attachedPages ?? 0})，跳过重复启动`;
      this.log(msg);
      return { id: plugin.id, status: 'already-running', message: msg };
    }

    const processes = await this.listProcesses();
    const existing = matchPluginProcesses(processes, plugin);
    if (existing.length > 0) {
      const pids = existing.map((p) => p.ProcessId).join(', ');
      const msg = `插件 ${plugin.id} 进程已在运行 (PID: ${pids})，跳过重复启动`;
      this.log(msg);
      return { id: plugin.id, status: 'already-running', pids: existing.map((p) => p.ProcessId), message: msg };
    }

    const args = this.getPluginArgs(plugin, mode);
    if (extraEnv.ELECTRON_RUN_AS_NODE === '1' && !args.includes('--agy-node-runtime')) {
      args.push('--agy-node-runtime');
    }
    const outPath = path.join(this.logsDir, `${plugin.id}.out.log`);
    const errPath = path.join(this.logsDir, `${plugin.id}.err.log`);
    const outFd = openSync(outPath, 'w');
    const errFd = openSync(errPath, 'w');

    this.log(`正在静默启动插件 ${plugin.id}: ${cmd} ${args.join(' ')}`);
    const env = { ...process.env, ...extraEnv, ...(plugin.env && typeof plugin.env === 'object' ? plugin.env : {}) };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: path.dirname(this.pluginsDir),
        env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
      });
      child.unref();
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }

    await sleep(700);
    if (!isPidAlive(child.pid)) {
      const msg = `插件 ${plugin.id} 启动后立即退出，请查看日志: ${errPath}`;
      this.log(msg, 'WARN');
      return { id: plugin.id, status: 'exited', pid: child.pid, message: msg };
    }

    const msg = `插件 ${plugin.id} 已启动 (PID=${child.pid})，日志: ${outPath}`;
    this.log(msg);
    return { id: plugin.id, status: 'started', pid: child.pid, message: msg };
  }

  async stopPlugin(id) {
    const config = this.loadConfig();
    const plugin = config.plugins.find((p) => p.id === id);
    if (!plugin) throw new Error(`未找到插件: ${id}`);

    const { cmd, extraEnv } = this.resolveCommandWithEnv(plugin.command, config.antigravityExe || '');
    let stoppedAny = false;

    if (Array.isArray(plugin.stopArgs) && plugin.stopArgs.length > 0) {
      const cmdReady = !(cmd.includes(path.sep) || /\.(exe|cmd|bat|ps1)$/i.test(cmd)) || existsSync(cmd);
      if (cmdReady) {
        this.log(`尝试优雅停止插件 ${plugin.id}: ${cmd} ${plugin.stopArgs.join(' ')}`);
        try {
          await execFileAsync(cmd, plugin.stopArgs, {
            cwd: path.dirname(this.pluginsDir),
            env: { ...process.env, ...extraEnv },
            windowsHide: true,
            timeout: 8000,
          });
          this.log(`插件 ${plugin.id} 停止命令已执行完成`);
          stoppedAny = true;
        } catch (err) {
          this.log(`执行 ${plugin.id} 停止命令失败: ${err.message}`, 'WARN');
        }
        await sleep(500);
      }
    }

    const processes = await this.listProcesses();
    const residual = matchPluginProcesses(processes, plugin);
    for (const proc of residual) {
      try {
        process.kill(proc.ProcessId, 'SIGTERM');
        await sleep(250);
        if (isPidAlive(proc.ProcessId)) {
          process.kill(proc.ProcessId, 'SIGKILL');
        }
        this.log(`已终止残留插件进程 ${plugin.id} (PID=${proc.ProcessId})`);
        stoppedAny = true;
      } catch (err) {
        this.log(`无法终止残留进程 ${plugin.id} (PID=${proc.ProcessId}): ${err.message}`, 'WARN');
      }
    }

    if (!stoppedAny) {
      this.log(`插件 ${plugin.id} 当前未运行`);
    }
    return { id: plugin.id, stopped: stoppedAny };
  }

  async stopAllPlugins() {
    const config = this.loadConfig();
    const results = [];
    for (const plugin of config.plugins) {
      results.push(await this.stopPlugin(plugin.id));
    }
    this.log('所有托管插件停止流程已完成（未影响 Antigravity.exe 本体）');
    return results;
  }

  saveLifecycleConfig(lifecycleInput) {
    const config = this.loadConfig();
    config.lifecycle = {
      autoCleanupOnExit: lifecycleInput?.autoCleanupOnExit !== false,
      stopPluginsOnExit: lifecycleInput?.stopPluginsOnExit !== false,
    };
    this.saveConfig(config);
    this.log(
      `已保存生命周期配置 (autoCleanupOnExit=${config.lifecycle.autoCleanupOnExit}, stopPluginsOnExit=${config.lifecycle.stopPluginsOnExit})`
    );
    return config.lifecycle;
  }

  async cleanupAntigravityResiduals(options = {}) {
    const config = this.loadConfig();
    const lifecycle = config.lifecycle || {};
    const shouldStopPlugins =
      options.stopPlugins === undefined
        ? lifecycle.stopPluginsOnExit !== false
        : Boolean(options.stopPlugins);
    const force = Boolean(options.force);
    const agyExe = String(config.antigravityExe || '');

    const initialProcs = await this.listProcesses();
    const initialTargets = findAntigravityCleanupTargets(initialProcs, agyExe);
    if (initialTargets.mainPids.length > 0 && !force) {
      return {
        skipped: true,
        reason: 'Antigravity 主窗口仍在运行',
        mainPids: initialTargets.mainPids,
        killedPids: [],
        pluginResults: [],
      };
    }

    const killedPids = [];
    const seen = new Set();

    for (let pass = 0; pass < 3; pass += 1) {
      const procs = await this.listProcesses();
      const targets = findAntigravityCleanupTargets(procs, agyExe);
      if (targets.mainPids.length > 0 && !force) break;
      const ordered = [
        ...targets.agyNodeCmdPids,
        ...targets.languageServerPids,
        ...targets.sidecarChildPids,
      ];
      const pending = ordered.filter((pid) => !seen.has(pid));
      if (pending.length === 0) break;
      for (const pid of pending) {
        seen.add(pid);
        try {
          await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            timeout: 5000,
          });
          killedPids.push(pid);
        } catch (err) {
          this.log(`清理残留进程 PID=${pid} 失败: ${err.message}`, 'WARN');
        }
      }
      await sleep(200);
    }

    const pluginResults = shouldStopPlugins ? await this.stopAllPlugins() : [];

    if (killedPids.length > 0 || pluginResults.length > 0) {
      this.log(`已完成退出清理: 终止残留 AGY 进程 ${killedPids.length} 个`);
    } else {
      this.log('退出清理检查完成: 未发现残留 AGY 进程');
    }
    return { skipped: false, killedPids, pluginResults };
  }

  async restartPlugin(id) {
    await this.stopPlugin(id);
    await sleep(300);
    return this.startPlugin(id, 'attach');
  }

  async togglePlugin(id, enabled) {
    const config = this.loadConfig();
    const plugin = config.plugins.find((p) => p.id === id);
    if (!plugin) throw new Error(`未找到插件: ${id}`);
    plugin.enabled = typeof enabled === 'boolean' ? enabled : !plugin.enabled;
    this.saveConfig(config);
    this.log(`已将插件 ${plugin.id} enabled 设为 ${plugin.enabled}`);
    return plugin;
  }

  savePluginEntry(mode, payload) {
    const config = this.loadConfig();
    const id = String(payload?.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(id)) {
      throw new Error('插件 ID 仅允许字母、数字、连字符和下划线（长度 2-64）');
    }

    const toArgArray = (val) => {
      if (Array.isArray(val)) return val.map((item) => String(item)).filter(Boolean);
      if (typeof val === 'string') return val.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return [];
    };

    const nextEntry = {
      id,
      name: String(payload.name || id).trim(),
      version: String(payload.version || '').trim() || undefined,
      description: String(payload.description || '').trim(),
      enabled: payload.enabled !== false,
      autoAttach: payload.autoAttach !== false,
      type: String(payload.type || 'custom-cdp').trim(),
      command: String(payload.command || '').trim(),
      launchArgs: toArgArray(payload.launchArgs),
      attachArgs: toArgArray(payload.attachArgs),
      stopArgs: toArgArray(payload.stopArgs),
      healthUrl: String(payload.healthUrl || '').trim() || undefined,
      processMatch: String(payload.processMatch || '').trim() || undefined,
    };

    if (!nextEntry.command) throw new Error('启动命令 command 不能为空');
    if (nextEntry.attachArgs.length === 0 && nextEntry.launchArgs.length > 0) {
      nextEntry.attachArgs = [...nextEntry.launchArgs];
    }

    const idx = config.plugins.findIndex((p) => p.id === id);
    if (mode === 'create') {
      if (idx !== -1) throw new Error(`插件 ID 已存在: ${id}`);
      config.plugins.push(nextEntry);
      this.log(`新增托管插件配置: ${id}`);
    } else {
      if (idx === -1) throw new Error(`未找到待编辑插件: ${id}`);
      const merged = { ...config.plugins[idx], ...nextEntry };
      for (const optKey of ['version', 'healthUrl', 'processMatch']) {
        if (!nextEntry[optKey]) delete merged[optKey];
      }
      config.plugins[idx] = merged;
      this.log(`更新托管插件配置: ${id}`);
    }

    this.saveConfig(config);
    return nextEntry;
  }

  async deletePluginEntry(id) {
    const config = this.loadConfig();
    const idx = config.plugins.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error(`未找到插件: ${id}`);
    await this.stopPlugin(id);
    config.plugins.splice(idx, 1);
    this.saveConfig(config);
    this.log(`已移除托管插件配置: ${id}`);
    return { id, deleted: true };
  }

  async installPluginPackage(packagePath, overwrite = true) {
    const pkgPath = path.resolve(String(packagePath || ''));
    if (!existsSync(pkgPath) || !statSync(pkgPath).isFile()) {
      throw new Error(`插件安装包不存在: ${pkgPath}`);
    }
    const ext = path.extname(pkgPath).toLowerCase();
    if (!SUPPORTED_PACKAGE_EXTS.has(ext)) {
      throw new Error(`不支持的插件包格式: ${ext}（仅支持 .zip / .agypkg / .agy-plugin）`);
    }

    const entries = readZipEntries(readFileSync(pkgPath));
    const fileEntries = entries.filter((e) => !e.isDir);
    if (fileEntries.length === 0) {
      throw new Error('插件安装包为空');
    }

    let stripPrefix = '';
    let manifestEntry = fileEntries.find((e) => e.rel === 'agy-plugin.json') || null;
    if (!manifestEntry) {
      const allNested = fileEntries.every((e) => e.rel.includes('/'));
      const topDirs = new Set(fileEntries.filter((e) => e.rel.includes('/')).map((e) => e.rel.split('/', 1)[0]));
      if (allNested && topDirs.size === 1) {
        const topDir = [...topDirs][0];
        const nested = fileEntries.find((e) => e.rel === `${topDir}/agy-plugin.json`) || null;
        if (nested) {
          stripPrefix = `${topDir}/`;
          manifestEntry = nested;
        }
      }
    }
    if (!manifestEntry) {
      throw new Error('插件包缺少有效的 agy-plugin.json 清单');
    }

    let manifestRaw;
    try {
      manifestRaw = JSON.parse(manifestEntry.data.toString('utf8').replace(/^\uFEFF/, ''));
    } catch (err) {
      throw new Error(`解析 agy-plugin.json 失败: ${err.message}`);
    }

    const entry = normalizePluginPackageManifest(manifestRaw);
    const pluginId = entry.id;
    const config = this.loadConfig();
    const existingIdx = config.plugins.findIndex((p) => p.id === pluginId);
    const destDir = path.resolve(this.pluginsDir, pluginId);
    const replaced = existingIdx !== -1 || existsSync(destDir);
    if (replaced && !overwrite) {
      throw new Error(`插件已存在且未允许覆盖: ${pluginId}`);
    }

    if (existingIdx !== -1) {
      await this.stopPlugin(pluginId);
    }

    mkdirSync(this.pluginsDir, { recursive: true });
    const stagingDir = path.resolve(this.pluginsDir, `.staging-${pluginId}-${process.pid}-${Date.now()}`);
    const backupDir = path.resolve(this.pluginsDir, `.backup-${pluginId}-${process.pid}-${Date.now()}`);
    mkdirSync(stagingDir, { recursive: true });

    try {
      for (const item of entries) {
        if (stripPrefix && `${item.rel}/` === stripPrefix) continue;
        const innerRel =
          stripPrefix && item.rel.startsWith(stripPrefix) ? item.rel.slice(stripPrefix.length) : item.rel;
        if (!innerRel || innerRel === 'agy-plugin.json') continue;
        const target = path.resolve(stagingDir, innerRel);
        if (target !== stagingDir && !target.startsWith(`${stagingDir}${path.sep}`)) {
          throw new Error(`检测到路径穿越 (Zip-Slip): ${item.rel}`);
        }
        if (item.isDir) {
          mkdirSync(target, { recursive: true });
        } else {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, item.data);
        }
      }

      if (existsSync(destDir)) {
        renameSync(destDir, backupDir);
      }
      try {
        renameSync(stagingDir, destDir);
      } catch (err) {
        if (existsSync(backupDir) && !existsSync(destDir)) {
          renameSync(backupDir, destDir);
        }
        throw err;
      }
      if (existsSync(backupDir)) {
        rmSync(backupDir, { recursive: true, force: true });
      }
    } finally {
      if (existsSync(stagingDir)) {
        rmSync(stagingDir, { recursive: true, force: true });
      }
    }

    const saved = this.savePluginEntry(existingIdx !== -1 ? 'edit' : 'create', entry);
    this.log(`已安装插件包 ${pluginId} -> ${destDir} (replaced=${replaced})`);
    return {
      plugin: saved,
      installedDir: destDir,
      replaced,
    };
  }

  saveProxyConfig(proxyInput) {
    const config = this.loadConfig();
    const existingNoProxy = String(config.proxy?.noProxy || '').trim();
    const rawNoProxy = proxyInput?.noProxy != null ? String(proxyInput.noProxy).trim() : '';
    config.proxy = {
      enabled: Boolean(proxyInput?.enabled),
      httpProxy: String(proxyInput?.httpProxy || '').trim(),
      httpsProxy: String(proxyInput?.httpsProxy || '').trim(),
      allProxy: String(proxyInput?.allProxy || '').trim(),
      noProxy: rawNoProxy
        ? normalizeNoProxyList(rawNoProxy)
        : existingNoProxy
          ? normalizeNoProxyList(existingNoProxy)
          : DEFAULT_NO_PROXY,
      electronProxyServer: String(proxyInput?.electronProxyServer || '').trim(),
    };
    this.saveConfig(config);
    this.log(`已保存代理配置 (enabled=${config.proxy.enabled})`);
    return config.proxy;
  }

  readLogTail(id, tailLines = 150) {
    const cleanId = String(id || '').trim();
    if (!/^[a-z0-9._-]+$/i.test(cleanId)) {
      throw new Error('非法的日志标识');
    }
    const targetFile =
      cleanId === 'launcher'
        ? this.launcherLogPath
        : cleanId.endsWith('.err')
          ? path.join(this.logsDir, `${cleanId.slice(0, -4)}.err.log`)
          : path.join(this.logsDir, `${cleanId}.out.log`);

    const resolved = path.resolve(targetFile);
    if (!resolved.startsWith(path.resolve(this.logsDir) + path.sep)) {
      throw new Error('非法日志路径');
    }
    if (!existsSync(resolved)) {
      return { id, path: resolved, content: '', bytes: 0 };
    }
    const raw = readFileSync(resolved, 'utf8');
    const lines = raw.split(/\r?\n/);
    const limit = Math.max(10, Math.min(Number(tailLines) || 150, 1000));
    return {
      id,
      path: resolved,
      bytes: Buffer.byteLength(raw, 'utf8'),
      content: lines.slice(-limit).join('\n'),
    };
  }

  clearLog(id) {
    const info = this.readLogTail(id, 1);
    writeFileSync(info.path, '', 'utf8');
    return { id, cleared: true };
  }

  listNativePlugins() {
    if (!existsSync(this.geminiPluginsDir)) return [];

    let stateMap = {};
    try {
      if (existsSync(this.geminiConfigPath)) {
        const cfg = JSON.parse(readFileSync(this.geminiConfigPath, 'utf8'));
        stateMap = cfg.plugins || {};
      }
    } catch {
      stateMap = {};
    }

    const dirs = readdirSync(this.geminiPluginsDir, { withFileTypes: true }).filter((d) =>
      d.isDirectory()
    );
    const items = [];

    for (const dirEntry of dirs) {
      const dirName = dirEntry.name;
      const fullDir = path.join(this.geminiPluginsDir, dirName);
      const manifestPath = path.join(fullDir, 'plugin.json');
      if (!existsSync(manifestPath)) continue;

      let manifest = {};
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      } catch {
        continue;
      }

      const skillsDir = path.join(fullDir, 'skills');
      const skillCount = existsSync(skillsDir)
        ? readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length
        : 0;

      const sidecarsDir = path.join(fullDir, 'sidecars');
      const sidecars = [];
      if (existsSync(sidecarsDir)) {
        for (const scDir of readdirSync(sidecarsDir, { withFileTypes: true }).filter((d) =>
          d.isDirectory()
        )) {
          const scJsonPath = path.join(sidecarsDir, scDir.name, 'sidecar.json');
          if (!existsSync(scJsonPath)) continue;
          try {
            const scJson = JSON.parse(readFileSync(scJsonPath, 'utf8'));
            const auxView = (scJson.ui_config?.views || []).find(
              (v) => v.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE'
            );
            sidecars.push({
              id: scDir.name,
              displayName: scJson.display_name || scDir.name,
              hasWebUi: Boolean(scJson.has_web_ui),
              sidecarUri: auxView
                ? `sidecar://${dirName}/${scDir.name}${auxView.path?.startsWith('/') ? auxView.path : `/${auxView.path || ''}`}`
                : null,
            });
          } catch {
            // Skip malformed sidecar.json
          }
        }
      }

      const stateEntry = stateMap[dirName];
      const enabled = stateEntry ? stateEntry.enabled !== false : true;
      items.push({
        dir: dirName,
        name: manifest.name || dirName,
        version: manifest.version || '-',
        description: manifest.description || '',
        enabled,
        marketplaceId: stateEntry?.installedFrom?.id || null,
        skillCount,
        hasMcp: existsSync(path.join(fullDir, 'mcp_config.json')),
        hasRules: existsSync(path.join(fullDir, 'rules')),
        sidecars,
        customizationUri: `customization://${dirName}`,
      });
    }

    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  async _createVbsShortcut({ fileName, vbsFileName, iconPath, description }) {
    const vbsPath = path.join(this.baseDir, vbsFileName);
    if (!existsSync(vbsPath)) {
      throw new Error(`未找到无窗启动脚本: ${vbsPath}`);
    }
    const desktopDir = existsSync('D:\\Desktop')
      ? 'D:\\Desktop'
      : path.join(os.homedir(), 'Desktop');
    const shortcutPath = path.join(desktopDir, fileName);
    const wscriptExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

    const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const psScript = `
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut(${psQuote(shortcutPath)})
$sc.TargetPath = ${psQuote(wscriptExe)}
$sc.Arguments = ${psQuote(`"${vbsPath}"`)}
$sc.WorkingDirectory = ${psQuote(this.baseDir)}
if (${psQuote(iconPath || '')} -and (Test-Path ${psQuote(iconPath || '')})) { $sc.IconLocation = ${psQuote(`${iconPath},0`)} }
$sc.Description = ${psQuote(description)}
$sc.Save()
`;
    await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      { windowsHide: true }
    );
    this.log(`已生成桌面快捷方式: ${shortcutPath}`);
    return { shortcutPath };
  }

  async createDesktopShortcut() {
    const config = this.loadConfig();
    return this._createVbsShortcut({
      fileName: 'Antigravity (AGY-Launcher).lnk',
      vbsFileName: 'launch-silent.vbs',
      iconPath: config.antigravityExe || '',
      description: '启动 Antigravity 并静默加载托管插件',
    });
  }

  async createManagerAppShortcut() {
    const appIcon = path.join(this.baseDir, 'ui', 'app.ico');
    return this._createVbsShortcut({
      fileName: 'AGY Dock.lnk',
      vbsFileName: 'launch-manager.vbs',
      iconPath: existsSync(appIcon) ? appIcon : '',
      description: '打开 AGY Dock 独立桌面控制台',
    });
  }

  async checkForUpdates({ timeoutMs = 6000, siteUrl, productSlug, currentVersion } = {}) {
    const config = this.loadConfig();
    const updateCfg = config && typeof config.update === 'object' && config.update ? config.update : {};
    const targetSite = validateUpdateSiteUrl(siteUrl || updateCfg.siteUrl || DEFAULT_UPDATE_SITE_URL);
    const targetSlug = String(productSlug || updateCfg.productSlug || DEFAULT_PRODUCT_SLUG).trim().toLowerCase();
    const current = normalizeSemverStr(currentVersion || APP_VERSION);
    const { manifestUrl, landingUrl } = buildUpdateUrls({
      siteUrl: targetSite,
      productSlug: targetSlug,
      currentVersion: current,
    });
    const checkedAt = new Date().toISOString();
    const cleanText = (val) => String(val || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();

    try {
      const response = await fetch(manifestUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          'User-Agent': `AGY-Dock/${current}`,
        },
        signal: AbortSignal.timeout(Math.max(2000, Number(timeoutMs) || 6000)),
      });
      if (response.status === 404) {
        return {
          status: 'unpublished',
          hasUpdate: false,
          currentVersion: current,
          latestVersion: '',
          manifestUrl,
          updateUrl: landingUrl,
          prompt: { title: '', body: '', button: '立即更新' },
          message: '官网暂未发布可用版本',
          checkedAt,
        };
      }
      if (!response.ok) {
        return {
          status: 'error',
          hasUpdate: false,
          currentVersion: current,
          latestVersion: '',
          manifestUrl,
          updateUrl: landingUrl,
          prompt: { title: '', body: '', button: '立即更新' },
          message: `更新检查失败 (HTTP ${response.status})`,
          checkedAt,
        };
      }
      const payload = await response.json();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return {
          status: 'error',
          hasUpdate: false,
          currentVersion: current,
          latestVersion: '',
          manifestUrl,
          updateUrl: landingUrl,
          prompt: { title: '', body: '', button: '立即更新' },
          message: '官网更新响应格式无效',
          checkedAt,
        };
      }
      if (!payload.release) {
        return {
          status: 'unpublished',
          hasUpdate: false,
          currentVersion: current,
          latestVersion: '',
          manifestUrl,
          updateUrl: landingUrl,
          prompt: { title: '', body: '', button: '立即更新' },
          message: '官网暂未发布可用版本',
          checkedAt,
        };
      }
      if (!parseSemver(payload.release.version)) {
        return {
          status: 'error',
          hasUpdate: false,
          currentVersion: current,
          latestVersion: '',
          manifestUrl,
          updateUrl: landingUrl,
          prompt: { title: '', body: '', button: '立即更新' },
          message: '官网更新清单缺少有效 SemVer 版本号',
          checkedAt,
        };
      }
      const latestVersion = normalizeSemverStr(payload.release.version);
      const hasUpdate = isNewerSemver(latestVersion, current);
      const promptRaw = payload.prompt && typeof payload.prompt === 'object' ? payload.prompt : {};
      return {
        status: 'ok',
        hasUpdate,
        currentVersion: current,
        latestVersion,
        available: Boolean(payload.available),
        manifestUrl,
        updateUrl: landingUrl,
        prompt: {
          title: cleanText(promptRaw.title) || `AGY Dock v${latestVersion} 已发布`,
          body: cleanText(promptRaw.body) || `当前版本 v${current}，最新版本 v${latestVersion}，可前往 HaoAn Lab 官网更新。`,
          button: cleanText(promptRaw.button) || '立即更新',
        },
        changelog: cleanText(payload.release.changelog),
        instructions: cleanText(payload.instructions),
        message: hasUpdate ? `发现新版本 v${latestVersion}` : `已是最新版本 (v${current})`,
        checkedAt,
      };
    } catch (err) {
      return {
        status: 'error',
        hasUpdate: false,
        currentVersion: current,
        latestVersion: '',
        manifestUrl,
        updateUrl: landingUrl,
        prompt: { title: '', body: '', button: '立即更新' },
        message: `无法连接官网更新服务: ${err?.message || String(err)}`,
        checkedAt,
      };
    }
  }
}

export function detectHostArch() {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

export function parseSemver(raw) {
  const match = UPDATE_SEMVER_RE.exec(String(raw || '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function normalizeSemverStr(raw, fallback = APP_VERSION) {
  const parsed = parseSemver(raw) || parseSemver(fallback) || [2, 1, 0];
  return `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
}

export function isNewerSemver(candidate, current) {
  const a = parseSemver(candidate);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

export function validateUpdateSiteUrl(siteUrl) {
  const cleaned = String(siteUrl || DEFAULT_UPDATE_SITE_URL).trim().replace(/\/+$/, '');
  const parsed = new URL(cleaned);
  if (parsed.origin === 'https://ahmustudyhelper.xyz' && parsed.href === parsed.origin + '/') {
    return DEFAULT_UPDATE_SITE_URL;
  }
  if (parsed.protocol === 'https:') return cleaned;
  if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
    return cleaned;
  }
  throw new Error('更新服务地址必须使用 HTTPS（本地调试仅限 localhost / 127.0.0.1）');
}

export function buildUpdateUrls({
  siteUrl = DEFAULT_UPDATE_SITE_URL,
  productSlug = DEFAULT_PRODUCT_SLUG,
  currentVersion = APP_VERSION,
  platformName = 'windows',
  arch = detectHostArch(),
} = {}) {
  const base = validateUpdateSiteUrl(siteUrl);
  const slug = String(productSlug || DEFAULT_PRODUCT_SLUG).trim().toLowerCase();
  if (!PRODUCT_SLUG_RE.test(slug)) {
    throw new Error(`无效的官网产品 slug: ${productSlug}`);
  }
  const ver = normalizeSemverStr(currentVersion);
  const resolvedArch = ['x64', 'arm64', 'universal'].includes(arch) ? arch : detectHostArch();
  const params = new URLSearchParams({ platform: platformName, arch: resolvedArch, from: ver });
  const encodedSlug = encodeURIComponent(slug);
  return {
    manifestUrl: `${base}/api/v1/products/${encodedSlug}/releases/latest?${params.toString()}`,
    landingUrl: `${base}/updates/${encodedSlug}?${params.toString()}`,
  };
}
