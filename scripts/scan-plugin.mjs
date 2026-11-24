import fs from 'node:fs';
import zlib from 'node:zlib';

const MAX_SCAN_FILE_BYTES = 4 * 1024 * 1024;
const BANNED_BINARY_EXTS = new Set([
  'exe', 'dll', 'msi', 'scr', 'com', 'pif', 'sys', 'drv', 'ocx', 'cpl', 'vbs', 'hta', 'bat', 'cmd',
]);
const ALLOWED_NON_PE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg', 'pdf', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'wasm', 'zip',
]);
const CODE_FILE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'ps1', 'psm1', 'psd1', 'py', 'pyw', 'html', 'htm', 'sh',
]);
const ALLOWED_INTERPRETER_EXES = new Set([
  'node.exe', 'python.exe', 'pythonw.exe', 'python3.exe', 'powershell.exe', 'pwsh.exe',
]);
const IGNORED_DOMAINS = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  'w3.org', 'www.w3.org', 'schemas.openxmlformats.org', 'schemas.microsoft.com',
  'purl.org', 'mozilla.org', 'www.mozilla.org', 'creativecommons.org',
  'opensource.org', 'spdx.org', 'example.com', 'www.example.com',
  'adobe.com', 'ns.adobe.com', 'apache.org', 'www.apache.org',
];

const URL_RE = /\b(?:https?|wss?):\/\/([a-z0-9.-]+\.[a-z]{2,})(?:[:/]|['"`\s]|$)/gi;
const HEX_OBF_RE = /\b_0x[a-fA-F0-9]{4,}\b/g;
const DIRECT_KILL_RE = /(?:\btaskkill\b|\bStop-Process\b|\bTerminateProcess\b|\bpskill\b|wmic\s+process\b[^\r\n;]*\bdelete\b|(?:execSync|execFileSync|exec|spawnSync|spawn|system|popen)\s*\([^)]*\b(?:killall|pkill)\b)/i;
const PS_DOTNET_KILL_RE = /\.\s*Kill\s*\(/;
const OBFUSCATED_EVAL_RE = /(?:eval\s*\(\s*(?:atob|Buffer\.from|unescape|decodeURIComponent)\s*\(|new\s+Function\s*\(\s*(?:atob|Buffer\.from)\s*\(|powershell(?:\.exe)?\b[^\r\n]*\s-(?:e|enc|encodedcommand)\b|Invoke-Expression\b|\biex\s+[($])/i;
const HARD_CREDENTIAL_RE = /(?:CryptUnprotectData|\bcmdkey\b|\bvaultcmd\b|\.ssh[\\/]id_|\.aws[\\/]credentials|CurrentVersion[\\/]Run)/i;
const BROWSER_CRED_FILE_RE = /(?:Login Data|Local State|Web Data)/i;
const DEFENSIVE_DENYLIST_RE = /(?:sensitive|deny|block|forbid|blacklist|restricted|excluded|ignored|disallow|protected)/i;
const CRED_ACCESS_CONTEXT_RE = /(?:user data|\bchrome\b|\bedge\b|\bbrave\b|\bopera\b|\bappdata\b|localappdata|readfile|createreadstream|copyfile|\bsqlite\b|\bdatabase\b|\bopen\s*\()/i;
const QUOTED_CRED_BASENAME_RE = /(['"`])(?:login data|local state|web data)(?:-(?:journal|wal|shm))?\1/gi;
const PURE_LIST_ENTRY_LINE_RE = /^\s*(?:(?:['"`][^'"`\r\n]*['"`]|\/[^/\r\n]+\/[gimsuy]*)\s*,?\s*)+$/;
const DESTRUCTIVE_OS_RE = /(?:\brm\s+-rf\b|\brmdir\s+\/s\b|\brd\s+\/s\s+\/q\b|\bdel\s+\/f\s+\/s\b|\breg\s+(?:add|delete)\b|\bschtasks\b|\bsc\s+(?:create|delete)\b|\bbcdedit\b|\bvssadmin\b|\bSet-MpPreference\b|\bAdd-MpPreference\b)/i;
const OUTBOUND_NET_API_RE = /(?:\bfetch\s*\(|https?\.(?:request|get)\s*\(|new\s+WebSocket\s*\(|XMLHttpRequest|Invoke-WebRequest|Invoke-RestMethod|urllib\.request|\brequests\.(?:get|post|put|request)\b|\baxios\b|net\.connect|tls\.connect)/i;
const CHAT_OR_BRAIN_RE = /(?:\.gemini[\\/](?:antigravity[\\/])?(?:conversations|brain)|state\.vscdb|conversation_history|chat_history)/i;
const OUTSIDE_FS_RE = /(?:\\Desktop\b|\\Documents\b|\\Downloads\b|\\Startup\b|C:[\\/]Windows|ProgramData|USERPROFILE|\$env:USERPROFILE|\$env:APPDATA)/i;
const MANAGER_BRIDGE_RE = /(?:AGY_BRIDGE_URL|AGY_BRIDGE_TOKEN|\/v1\/antigravity\/children\/kill)/i;

function readZipEntries(buffer) {
  let eocdOffset = -1;
  const minOffset = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('无效的 ZIP 插件包（缺少目录尾）');
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const entries = [];
  let ptr = cdOffset;
  for (let i = 0; i < totalEntries && ptr < cdOffset + cdSize; i += 1) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) throw new Error('无效的 ZIP 中央目录条目');
    const compression = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const uncompSize = buffer.readUInt32LE(ptr + 24);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localHeaderOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;

    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`无效的 ZIP 本地文件头: ${name}`);
    }
    const lhNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const rawSlice = buffer.subarray(dataStart, dataStart + compSize);
    let data = Buffer.alloc(0);
    if (uncompSize <= MAX_SCAN_FILE_BYTES) {
      if (compression === 0) data = Buffer.from(rawSlice);
      else if (compression === 8) data = zlib.inflateRawSync(rawSlice);
      else throw new Error(`不支持的 ZIP 压缩方式 (${compression}): ${name}`);
    } else if (compression === 0) {
      data = Buffer.from(rawSlice.subarray(0, 64));
    }
    entries.push({ name, data });
  }
  return entries;
}

function isVendoredMinifiedAsset(relLower) {
  return (
    relLower.endsWith('.min.js') ||
    relLower.endsWith('.min.mjs') ||
    relLower.includes('/pdfjs/') ||
    relLower.includes('pdf.worker.') ||
    relLower.includes('pdf.min.') ||
    relLower.includes('woff2_decompress') ||
    relLower.startsWith('webview/assets/') ||
    relLower.includes('/webview/assets/')
  );
}

function getExt(relLower) {
  const base = relLower.split('/').pop() || '';
  const idx = base.lastIndexOf('.');
  return idx >= 0 ? base.slice(idx + 1) : '';
}

function isIgnoredDomain(host) {
  const lower = host.trim().toLowerCase();
  return IGNORED_DOMAINS.some((d) => lower === d || lower.endsWith(`.${d}`));
}

function isUrlOnlyForBrowserOpen(text, line) {
  const ll = line.toLowerCase();
  if (ll.includes('openexternalurl(') || ll.includes('window.open(') || ll.includes('href=')) {
    return true;
  }
  const m = line.trim().match(/^(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=/);
  if (m) {
    const ident = m[1];
    const lines = text.split(/\r?\n/);
    let totalRefs = 0;
    let safeRefs = 0;
    for (const l of lines) {
      if (l.includes(ident)) {
        totalRefs += 1;
        const t = l.trim();
        const tLower = t.toLowerCase();
        if (
          /^(?:const|let|var)\s+/.test(t) ||
          tLower.includes('openexternalurl(') ||
          tLower.includes('window.open(')
        ) {
          safeRefs += 1;
        }
      }
    }
    if (totalRefs > 0 && totalRefs === safeRefs) return true;
  }
  return false;
}

export function stripComments(text, ext) {
  const src = String(text || '');
  const e = String(ext || '').toLowerCase();
  if (['html', 'htm'].includes(e)) {
    return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\r\n]/g, ' '));
  }
  const isJsLike = ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'].includes(e);
  const isPySh = ['py', 'pyw', 'sh'].includes(e);
  const isPs = ['ps1', 'psm1', 'psd1'].includes(e);
  if (!isJsLike && !isPySh && !isPs) return src;

  const out = [];
  let i = 0;
  let quote = '';
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (quote) {
      out.push(ch);
      if (ch === '\\' && !isPs && i + 1 < n) {
        i += 1;
        out.push(src[i]);
      } else if (ch === quote) {
        quote = '';
      }
      i += 1;
      continue;
    }

    if (ch === '\'' || ch === '"' || (isJsLike && ch === '`')) {
      quote = ch;
      out.push(ch);
      i += 1;
      continue;
    }

    if (isJsLike && ch === '/' && i + 1 < n) {
      const next = src[i + 1];
      if (next === '/') {
        while (i < n && src[i] !== '\n' && src[i] !== '\r') {
          out.push(' ');
          i += 1;
        }
        continue;
      }
      if (next === '*') {
        out.push(' ', ' ');
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
          out.push(src[i] === '\n' || src[i] === '\r' ? src[i] : ' ');
          i += 1;
        }
        if (i < n) {
          out.push(' ', ' ');
          i += 2;
        }
        continue;
      }
    }

    if (isPs && ch === '<' && src[i + 1] === '#') {
      out.push(' ', ' ');
      i += 2;
      while (i < n && !(src[i] === '#' && src[i + 1] === '>')) {
        out.push(src[i] === '\n' || src[i] === '\r' ? src[i] : ' ');
        i += 1;
      }
      if (i < n) {
        out.push(' ', ' ');
        i += 2;
      }
      continue;
    }

    if ((isPySh || isPs) && ch === '#') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') {
        out.push(' ');
        i += 1;
      }
      continue;
    }

    out.push(ch);
    i += 1;
  }
  return out.join('');
}

export function hasCredentialTheftRisk(codeText) {
  const src = String(codeText || '');
  if (HARD_CREDENTIAL_RE.test(src)) return true;
  if (!BROWSER_CRED_FILE_RE.test(src)) return false;

  const lines = src.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (!BROWSER_CRED_FILE_RE.test(line)) continue;
    if (CRED_ACCESS_CONTEXT_RE.test(line)) return true;
    const withoutBenignQuoted = line.replace(QUOTED_CRED_BASENAME_RE, ' ');
    if (BROWSER_CRED_FILE_RE.test(withoutBenignQuoted)) return true;

    let hasDefensiveContext = DEFENSIVE_DENYLIST_RE.test(line);
    if (!hasDefensiveContext) {
      const end = Math.min(lines.length - 1, idx + 2);
      for (let j = idx + 1; j <= end; j += 1) {
        if (DEFENSIVE_DENYLIST_RE.test(lines[j])) {
          hasDefensiveContext = true;
          break;
        }
      }
    }
    if (!hasDefensiveContext) {
      const shortStart = Math.max(0, idx - 12);
      const longStart = Math.max(0, idx - 120);
      for (let j = idx - 1; j >= longStart; j -= 1) {
        if (DEFENSIVE_DENYLIST_RE.test(lines[j])) {
          hasDefensiveContext = true;
          break;
        }
        if (j < shortStart && lines[j].trim() !== '' && !PURE_LIST_ENTRY_LINE_RE.test(lines[j])) {
          break;
        }
      }
    }
    if (!hasDefensiveContext) return true;
  }
  return false;
}

function addFinding(findings, finding) {
  if (!findings.some((f) => f.code === finding.code && f.file === finding.file && f.severity === finding.severity)) {
    findings.push(finding);
  }
}

export function scanZipBuffer(buffer) {
  const entries = readZipEntries(buffer);
  const findings = [];
  const externalDomains = [];
  const externalDomainSet = new Set();
  let scannedFiles = 0;
  let manifestJson = null;

  for (const entry of entries) {
    const rel = entry.name.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
    const relLower = rel.toLowerCase();
    const ext = getExt(relLower);

    if (BANNED_BINARY_EXTS.has(ext)) {
      addFinding(findings, {
        severity: 'high',
        code: 'BANNED_BINARY_FILE',
        title: '禁止包含可执行程序或系统脚本',
        detail: `压缩包内包含 .${ext} 文件，安全策略禁止黑盒可执行程序上架或安装`,
        file: rel,
        targets: [rel],
      });
      continue;
    }

    const buf = entry.data;
    if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a && !ALLOWED_NON_PE_EXTS.has(ext)) {
      addFinding(findings, {
        severity: 'high',
        code: 'BANNED_PE_BINARY',
        title: '检测到伪装的可执行二进制文件',
        detail: '文件内容为 Windows 可执行程序头，已拦截',
        file: rel,
        targets: [rel],
      });
      continue;
    }

    if (relLower === 'agy-plugin.json' || relLower.endsWith('/agy-plugin.json')) {
      try {
        manifestJson = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
      } catch {}
      continue;
    }

    if (!CODE_FILE_EXTS.has(ext)) continue;
    scannedFiles += 1;
    const text = buf.toString('utf8');
    const codeText = stripComments(text, ext);
    const isVendored = isVendoredMinifiedAsset(relLower);

    if (!isVendored) {
      const isPs = ext === 'ps1' || ext === 'psm1' || ext === 'psd1';
      if (DIRECT_KILL_RE.test(codeText) || (isPs && PS_DOTNET_KILL_RE.test(codeText))) {
        addFinding(findings, {
          severity: 'high',
          code: 'DIRECT_PROCESS_KILL',
          title: '直接调用系统命令强杀进程',
          detail: '代码直接调用了强行结束电脑进程的命令；如需清理卡死子代理，请改用管理器提供的白名单代办通道',
          file: rel,
          targets: [],
        });
      }
      if (OBFUSCATED_EVAL_RE.test(codeText) || (codeText.match(HEX_OBF_RE) || []).length >= 5) {
        addFinding(findings, {
          severity: 'high',
          code: 'OBFUSCATED_EXECUTION',
          title: '检测到故意加密混淆或隐蔽执行代码',
          detail: '代码使用了加密解码后动态执行或高度混淆写法，无法看清真实意图',
          file: rel,
          targets: [],
        });
      }
      if (hasCredentialTheftRisk(codeText)) {
        addFinding(findings, {
          severity: 'high',
          code: 'CREDENTIAL_OR_PERSISTENCE',
          title: '读取电脑敏感凭据或尝试开机自启',
          detail: '代码疑似访问浏览器密码库、系统凭据或写入系统自启项',
          file: rel,
          targets: [],
        });
      }
      if (DESTRUCTIVE_OS_RE.test(codeText)) {
        addFinding(findings, {
          severity: 'high',
          code: 'DESTRUCTIVE_OS_COMMAND',
          title: '包含高危系统修改或批量删除指令',
          detail: '代码包含修改注册表、计划任务、系统服务或递归强删目录等高危指令',
          file: rel,
          targets: [],
        });
      }

      if (OUTBOUND_NET_API_RE.test(codeText)) {
        const fileDomains = [];
        for (const line of codeText.split(/\r?\n/)) {
          if (isUrlOnlyForBrowserOpen(codeText, line)) continue;
          URL_RE.lastIndex = 0;
          let match;
          while ((match = URL_RE.exec(line)) !== null) {
            const host = String(match[1] || '').trim().toLowerCase();
            if (host && !isIgnoredDomain(host)) {
              if (!externalDomainSet.has(host)) {
                externalDomainSet.add(host);
                externalDomains.push(host);
              }
              if (!fileDomains.includes(host)) fileDomains.push(host);
            }
          }
        }
        if (fileDomains.length > 0) {
          addFinding(findings, {
            severity: 'low',
            code: 'EXTERNAL_NETWORK',
            title: '向外部网址发送或请求数据',
            detail: `代码会连接外部地址：${fileDomains.join('、')}`,
            file: rel,
            targets: fileDomains,
          });
        }
      }

      if (CHAT_OR_BRAIN_RE.test(codeText)) {
        addFinding(findings, {
          severity: 'low',
          code: 'READS_CONVERSATION_DATA',
          title: '读取 Antigravity 对话或工作区记录',
          detail: '代码会读取本地对话历史或工作区记录目录',
          file: rel,
          targets: [],
        });
      }

      if (
        OUTSIDE_FS_RE.test(codeText) &&
        !codeText.includes('DevToolsActivePort') &&
        /(writeFile|mkdir|rmSync|unlink|Set-Content|Out-File)/.test(codeText)
      ) {
        addFinding(findings, {
          severity: 'low',
          code: 'OUTSIDE_PLUGIN_FS_WRITE',
          title: '向插件自身目录以外写入或修改文件',
          detail: '代码会在用户主目录或系统数据目录下写入文件',
          file: rel,
          targets: [],
        });
      }

      if (MANAGER_BRIDGE_RE.test(codeText)) {
        addFinding(findings, {
          severity: 'low',
          code: 'MANAGER_BRIDGE_PROCESS_CONTROL',
          title: '请求管理器白名单清理 Antigravity 子进程',
          detail: '插件通过管理器提供的安全白名单代办通道关闭卡死的 Antigravity 子进程，不会触碰主窗口或其他软件',
          file: rel,
          targets: [],
        });
      }
    }
  }

  if (manifestJson && typeof manifestJson === 'object') {
    const pType = String(manifestJson.type || '').trim().toLowerCase();
    if (pType === 'exe-cdp') {
      addFinding(findings, {
        severity: 'high',
        code: 'BANNED_EXE_TYPE',
        title: '不支持可执行程序类型 (exe-cdp)',
        detail: '为确保代码透明可查，市场与安装包不再接收 exe-cdp 类型插件',
        file: 'agy-plugin.json',
        targets: [],
      });
    }
    const cmd = String(manifestJson.command || '').trim();
    const cmdBase = cmd.replace(/\\/g, '/').toLowerCase().split('/').pop() || '';
    if (cmdBase.endsWith('.exe') && !ALLOWED_INTERPRETER_EXES.has(cmdBase)) {
      addFinding(findings, {
        severity: 'high',
        code: 'BANNED_EXE_COMMAND',
        title: '启动命令指向非标准可执行文件',
        detail: `启动命令 (${cmd}) 必须为受支持的纯脚本运行环境，禁止直接运行自定义 .exe`,
        file: 'agy-plugin.json',
        targets: [cmd],
      });
    }
  }

  const hasHigh = findings.some((f) => f.severity === 'high');
  const hasLow = findings.some((f) => f.severity === 'low');
  const riskLevel = hasHigh ? 'high' : hasLow ? 'low' : 'none';
  const summary = hasHigh
    ? `筛查未通过：发现 ${findings.filter((f) => f.severity === 'high').length} 项高危风险行为，已自动拦截`
    : hasLow
      ? `发现 ${findings.filter((f) => f.severity === 'low').length} 项敏感行为提醒，请确认符合插件用途后再决定`
      : '代码筛查通过，未发现敏感或高危行为';

  return { riskLevel, blocked: hasHigh, summary, externalDomains, findings, scannedFiles };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('scan-plugin.mjs')) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const fileArg = args.find((a) => !a.startsWith('-'));
  if (!fileArg) {
    console.error('用法: node scripts/scan-plugin.mjs <插件zip路径> [--json]');
    process.exit(1);
  }
  try {
    const buf = fs.readFileSync(fileArg);
    const report = scanZipBuffer(buf);
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`[${report.riskLevel.toUpperCase()}] ${report.summary} (已扫描 ${report.scannedFiles} 个代码文件)`);
      for (const f of report.findings) {
        console.log(`  - [${f.severity}] ${f.title} (${f.file}): ${f.detail}`);
      }
    }
    process.exit(report.blocked ? 2 : 0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
