#!/usr/bin/env node

import { writeFileSync, readFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename, resolve, extname } from "node:path";
import { homedir, tmpdir } from "node:os";

const MODEL = "gpt-image-2";
const CONFIG_PATH = join(homedir(), ".codex", "opentoken-image-gen-config.json");
const API_SITES = {
  old: { label: "老站点", host: "api.opentoken.io", base: "https://api.opentoken.io/v1/images/generations" },
  new: { label: "新站点", host: "cn2.gw.opentoken.io", base: "https://cn2.gw.opentoken.io/v1/images/generations" },
};
const DEFAULT_API_SITE = "new";

const SIZE_MATRIX = {
  "1K": { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" },
  "2K": { square: "2048x2048", landscape: "2048x1536", portrait: "1536x2048" },
  "4K": { square: "2880x2880", landscape: "3840x2160", portrait: "2160x3840" },
};

const DEFAULTS = { quality: "2K", ratio: "square", count: 1, concurrency: 3 };
const RATIO_NAMES = { square: "正方形", landscape: "横版", portrait: "竖版" };
const QUALITY_EMOJI = { "1K": "🚀", "2K": "✨", "4K": "💎" };

// ── 安全校验常量 ──

const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_IMAGE_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const MAGIC_BYTES = {
  PNG:  { offset: 0, bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), exts: [".png"] },
  JPEG: { offset: 0, bytes: Buffer.from([0xff, 0xd8, 0xff]), exts: [".jpg", ".jpeg"] },
  WEBP: { offset: 0, bytes: Buffer.from([0x52, 0x49, 0x46, 0x46]), exts: [".webp"] },  // RIFF
};

/**
 * 校验 --image 参数指向的文件是否为合法图片
 * 四层防御：路径穿越 → 扩展名白名单 → 文件大小 → 文件头魔术字节
 * @param {string} filePath - 用户传入的图片路径
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateImageFile(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return { valid: false, reason: "图片路径不能为空" };
  }

  // Layer 4 (优先检测): 路径穿越检测
  const normalized = resolve(filePath);
  const homeDir = homedir();
  // 只允许在用户主目录和临时目录下的文件
  const allowedRoots = [homeDir, join(homeDir, "Pictures"), join(homeDir, "Desktop"), join(homeDir, "Documents"), join(homeDir, "Downloads"), tmpdir?.() || "/tmp"];
  const isUnderAllowedRoot = allowedRoots.some(root => normalized.startsWith(root + "/") || normalized.startsWith(root + "\\"));

  // 检测路径穿越特征
  const pathTraversalPattern = /(\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e%5c)/i;
  if (pathTraversalPattern.test(filePath)) {
    return { valid: false, reason: `路径包含非法穿越字符: ${filePath}` };
  }

  // 检测敏感目录访问
  const sensitivePaths = [".ssh", ".aws", ".gnupg", ".config", ".kube", "credentials", "private"];
  const pathSegments = normalized.split(/[/\\]/);
  for (const seg of pathSegments) {
    if (sensitivePaths.includes(seg.toLowerCase())) {
      return { valid: false, reason: `禁止访问敏感目录: ${seg}` };
    }
  }

  if (!isUnderAllowedRoot) {
    return { valid: false, reason: `图片路径超出允许范围，仅允许用户主目录和临时目录下的文件` };
  }

  // Layer 1: 扩展名白名单
  const ext = extname(filePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { valid: false, reason: `不支持的文件扩展名 "${ext}"，仅允许: ${[...ALLOWED_EXTENSIONS].join(", ")}` };
  }

  // Layer 3: 文件大小上限（放在文件头之前，避免读取大文件）
  if (existsSync(filePath)) {
    try {
      const stats = statSync(filePath);
      if (stats.size > MAX_IMAGE_FILE_SIZE) {
        return { valid: false, reason: `文件大小 ${(stats.size / 1024 / 1024).toFixed(1)}MB 超过上限 20MB` };
      }
      if (stats.size === 0) {
        return { valid: false, reason: "文件为空" };
      }
    } catch (err) {
      return { valid: false, reason: `无法读取文件信息: ${err.message}` };
    }
  }

  // Layer 2: 文件头魔术字节校验
  try {
    const head = readFileSync(filePath, { start: 0, end: 16 }); // 读取前16字节足够覆盖所有格式
    const formatMatch = Object.entries(MAGIC_BYTES).find(([, spec]) => {
      const slice = head.slice(spec.offset, spec.offset + spec.bytes.length);
      return slice.equals(spec.bytes);
    });

    if (!formatMatch) {
      return { valid: false, reason: `文件头不匹配任何支持的图片格式 (PNG/JPEG/WebP)` };
    }

    // WebP 额外校验：偏移 8-11 必须是 "WEBP"
    if (formatMatch[0] === "WEBP") {
      const webpMarker = head.slice(8, 12);
      if (!webpMarker.equals(Buffer.from([0x57, 0x45, 0x42, 0x50]))) {
        return { valid: false, reason: "文件头 RIFF 匹配但非 WebP 格式" };
      }
    }

    // 扩展名与实际格式交叉校验
    const detectedExts = formatMatch[1].exts;
    if (!detectedExts.includes(ext)) {
      return { valid: false, reason: `扩展名 ${ext} 与实际文件格式 ${formatMatch[0]} 不匹配` };
    }
  } catch (err) {
    return { valid: false, reason: `无法读取文件头: ${err.message}` };
  }

  return { valid: true };
}

function resolveSize(quality, ratio) {
  return SIZE_MATRIX[quality?.toUpperCase()]?.[ratio?.toLowerCase()] || null;
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); } catch { return null; }
}

function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function normalizeApiSite(site) {
  const s = String(site || "").toLowerCase();
  if (["old", "legacy", "api.opentoken.io", "老", "老站点"].includes(s)) return "old";
  if (["new", "cn2", "cn2.gw.opentoken.io", "新", "新站点"].includes(s)) return "new";
  return null;
}

function resolveApiSite(cfg) {
  return normalizeApiSite(cfg?.apiSite) || DEFAULT_API_SITE;
}

function resolveApiBase(cfg) {
  return API_SITES[resolveApiSite(cfg)].base;
}

function getApiKey() {
  const cfg = loadConfig();
  if (!cfg?.apiKey) {
    console.error("ERROR: API key not configured.");
    process.exit(1);
  }
  return cfg.apiKey;
}

function timestamp() {
  const d = new Date();
  return [
    d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"), "_",
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
    String(d.getSeconds()).padStart(2, "0"),
  ].join("");
}

function resolveOutputDir(userDir) {
  const dir = userDir || join(homedir(), "Pictures", "opentoken-image-gen");
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function generate(apiKey, prompt, size, outputDir, apiBase) {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 220_000);

  try {
    const res = await fetch(apiBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: MODEL, prompt, n: 1, size }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    if (!res.ok) {
      const body = await res.text();
      let msg;
      try { msg = JSON.parse(body).error?.message || body; } catch { msg = body; }
      return { ok: false, elapsed, error: `HTTP ${res.status}: ${msg}` };
    }

    const data = await res.json();
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) return { ok: false, elapsed, error: "No image data in response" };

    const buf = Buffer.from(b64, "base64");
    const filename = `img_${timestamp()}_${Math.random().toString(36).slice(2, 6)}.png`;
    const filepath = join(outputDir, filename);
    writeFileSync(filepath, buf);

    return { ok: true, elapsed, path: filepath, fileSize: `${(buf.length / 1024 / 1024).toFixed(2)}MB` };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, elapsed: Date.now() - start, error: err.name === "AbortError" ? "Timeout (220s)" : err.message };
  }
}

async function editImage(apiKey, imagePath, prompt, size, outputDir, apiBase, count = 1, silent = false) {
  if (!existsSync(imagePath)) {
    return { ok: false, elapsed: 0, error: `文件不存在: ${imagePath}`, sourceName: basename(imagePath) };
  }

  // 安全校验：防止任意文件读取
  const validation = validateImageFile(imagePath);
  if (!validation.valid) {
    return { ok: false, elapsed: 0, error: `安全校验失败: ${validation.reason}`, sourceName: basename(imagePath) };
  }

  const imageData = readFileSync(imagePath);
  const lp = imagePath.toLowerCase();
  const ext = lp.endsWith(".jpg") || lp.endsWith(".jpeg") ? "jpeg" : lp.endsWith(".webp") ? "webp" : "png";
  const dataUrl = `data:image/${ext};base64,${imageData.toString("base64")}`;
  const sourceName = basename(imagePath);

  if (!silent) {
    console.log(`🖼️ 加载 ${sourceName} (${(imageData.length / 1024 / 1024).toFixed(2)}MB)...`);
    console.log(count > 1 ? `✏️ 编辑中 × ${count}...\n` : `✏️ 编辑中...\n`);
  }

  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 250_000);

  try {
    const res = await fetch(apiBase, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: MODEL, prompt, n: count, size, image: dataUrl }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    if (!res.ok) {
      const body = await res.text();
      let msg;
      try { msg = JSON.parse(body).error?.message || body; } catch { msg = body; }
      return { ok: false, elapsed, error: `HTTP ${res.status}: ${msg}`, sourceName };
    }

    const data = await res.json();

    if (count > 1) {
      const results = [];
      const ts = timestamp();
      for (let i = 0; i < (data.data?.length || 0); i++) {
        const b64 = data.data[i]?.b64_json;
        if (b64) {
          const buf = Buffer.from(b64, "base64");
          const filename = `edit_${ts}_${i + 1}_${Math.random().toString(36).slice(2, 6)}.png`;
          const filepath = join(outputDir, filename);
          writeFileSync(filepath, buf);
          results.push({ path: filepath, fileSize: `${(buf.length / 1024 / 1024).toFixed(2)}MB` });
        }
      }
      return { ok: results.length > 0, elapsed, results, sourceName };
    }

    const b64 = data.data?.[0]?.b64_json;
    if (!b64) return { ok: false, elapsed, error: "No image data in response", sourceName };

    const buf = Buffer.from(b64, "base64");
    const filename = `edit_${timestamp()}_${Math.random().toString(36).slice(2, 6)}.png`;
    const filepath = join(outputDir, filename);
    writeFileSync(filepath, buf);

    return { ok: true, elapsed, path: filepath, fileSize: `${(buf.length / 1024 / 1024).toFixed(2)}MB`, sourceName };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, elapsed: Date.now() - start, error: err.name === "AbortError" ? "Timeout (250s)" : err.message, sourceName };
  }
}

async function runBatchEdit(apiKey, imagePaths, prompt, size, concurrency, outputDir, apiBase) {
  const total = imagePaths.length;
  console.log(`\n✏️ 批量编辑 ${total} 张\n`);

  const startAll = Date.now();
  const results = new Array(total);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < total) {
      const idx = nextIdx++;
      const imagePath = imagePaths[idx];
      console.log(`⏳ [${idx + 1}/${total}] ${basename(imagePath)}`);
      const result = await editImage(apiKey, imagePath, prompt, size, outputDir, apiBase, 1, true);
      results[idx] = result;
      if (result.ok) {
        console.log(`✅ [${idx + 1}/${total}] ${(result.elapsed / 1000).toFixed(1)}s`);
      } else {
        console.log(`❌ [${idx + 1}/${total}] ${result.error}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  const totalTime = Date.now() - startAll;

  const ok = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);

  console.log();

  const NUM = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
  console.log(`✏️ "${prompt}"\n`);
  const totalMB = ok.reduce((sum, r) => sum + parseFloat(r.fileSize), 0).toFixed(2);
  console.log(`✅ ${ok.length}/${total} ｜ ${(totalTime / 1000).toFixed(1)}s ｜ 共 ${totalMB}MB`);
  ok.forEach((r, i) => console.log(`${NUM[i] || "·"} ${basename(r.path)} ← ${r.sourceName}  ${r.fileSize}`));
  fail.forEach(r => console.log(`❌ ${r.sourceName}: ${r.error}`));
  console.log(`📍 ${outputDir}`);

  return fail.length > 0 ? 1 : 0;
}

async function batchGenerate(apiKey, prompts, size, concurrency, outputDir, apiBase, isVariation = false) {
  const total = prompts.length;
  const results = new Array(total);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < total) {
      const idx = nextIdx++;
      const prompt = prompts[idx];
      if (isVariation) {
        console.log(`⏳ [${idx + 1}/${total}]`);
      } else {
        console.log(`[${idx + 1}/${total}] 生成中: "${prompt.slice(0, 30)}${prompt.length > 30 ? "..." : ""}"`);
      }
      const result = await generate(apiKey, prompt, size, outputDir, apiBase);
      results[idx] = { prompt, ...result };
      if (result.ok) {
        console.log(`✅ [${idx + 1}/${total}] ${(result.elapsed / 1000).toFixed(1)}s`);
      } else {
        console.log(`❌ [${idx + 1}/${total}] ${result.error}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  return results;
}

async function runBatch(apiKey, prompts, size, concurrency, outputDir, apiBase, isVariation = false) {
  if (!isVariation) {
    console.log(`\n📦 批量 ${prompts.length} 张\n`);
  }

  const startAll = Date.now();
  const results = await batchGenerate(apiKey, prompts, size, concurrency, outputDir, apiBase, isVariation);
  const totalTime = Date.now() - startAll;

  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);

  console.log();

  if (isVariation) {
    const NUM = ["①", "②", "③", "④"];
    const p = results[0].prompt;
    const totalMB = ok.reduce((sum, r) => sum + parseFloat(r.fileSize), 0).toFixed(2);
    console.log(`🎨 "${p}" × ${results.length}\n`);
    console.log(`✅ ${(totalTime / 1000).toFixed(1)}s ｜ 共 ${totalMB}MB`);
    ok.forEach((r, i) => console.log(`${NUM[i] || "·"} ${basename(r.path)}  ${r.fileSize}`));
    fail.forEach((r) => console.log(`❌ ${r.error}`));
  } else {
    for (const r of results) {
      if (r.ok) {
        console.log(`🎨 "${r.prompt}" ✅ ${(r.elapsed / 1000).toFixed(1)}s ｜ ${r.fileSize}`);
        console.log(`📁 ${r.path}`);
      } else {
        console.log(`🎨 "${r.prompt}" ❌ ${r.error}`);
      }
      console.log();
    }
    console.log(`✅ ${ok.length}/${results.length} ｜ ${(totalTime / 1000).toFixed(1)}s`);
  }
  console.log(`📍 ${outputDir}`);
  return fail.length > 0 ? 1 : 0;
}

function printUsage() {
  console.log(`OpenToken Image Gen — AI Image Generation Tool

CONFIG:
  --get-config                              Show current config (JSON)
  --set-site <old|new>                      Save API site (old=api.opentoken.io, new=cn2.gw.opentoken.io)
  --set-key <key>                           Save API key
  --set-quick-mode --quality Q --ratio R --count N   Save quick mode defaults
  --set-batch-mode --quality Q --ratio R --concurrency N   Save batch mode defaults

GENERATE:
  --prompt "..."  [--quality Q] [--ratio R] [--count N] [--output-dir D]
  --batch <file.json>   [--quality Q] [--ratio R] [--concurrency N]
  --batch-inline "p1" "p2" ...   [--quality Q] [--ratio R] [--concurrency N]

EDIT:
  --edit --image <path> --prompt "..."  [--quality Q] [--ratio R] [--count N]
  --edit --image <p1> --image <p2> --prompt "..."  [--concurrency N]

Explicit flags override saved config. Without flags, saved mode config is used.

SIZE MATRIX:
  ┌─────────┬────────────┬────────────┬────────────┐
  │         │  square    │ landscape  │  portrait  │
  ├─────────┼────────────┼────────────┼────────────┤
  │   1K    │ 1024×1024  │ 1536×1024  │ 1024×1536  │
  │   2K    │ 2048×2048  │ 2048×1536  │ 1536×2048  │
  │   4K    │ 2880×2880  │ 3840×2160  │ 2160×3840  │
  └─────────┴────────────┴────────────┴────────────┘`);
}

function parseArgs(argv) {
  const args = { prompts: [], flags: {} };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if      (a === "--get-config")                  args.flags.getConfig = true;
    else if (a === "--set-site" && argv[i + 1])     args.flags.setSite = argv[++i];
    else if (a === "--set-key" && argv[i + 1])      args.flags.setKey = argv[++i];
    else if (a === "--set-quick-mode")               args.flags.setQuickMode = true;
    else if (a === "--set-batch-mode")                args.flags.setBatchMode = true;
    else if (a === "--prompt" && argv[i + 1])         args.prompts.push(argv[++i]);
    else if (a === "--quality" && argv[i + 1])        args.flags.quality = argv[++i];
    else if (a === "--ratio" && argv[i + 1])          args.flags.ratio = argv[++i];
    else if (a === "--count" && argv[i + 1])          args.flags.count = parseInt(argv[++i], 10);
    else if (a === "--output-dir" && argv[i + 1])     args.flags.outputDir = argv[++i];
    else if (a === "--concurrency" && argv[i + 1])    args.flags.concurrency = parseInt(argv[++i], 10);
    else if (a === "--batch" && argv[i + 1])          args.flags.batchFile = argv[++i];
    else if (a === "--batch-inline") {
      i++;
      while (i < argv.length && !argv[i].startsWith("--")) args.prompts.push(argv[i++]);
      args.flags.batchInline = true;
      continue;
    }
    else if (a === "--edit")                             args.flags.edit = true;
    else if (a === "--image" && argv[i + 1]) { if (!args.flags.images) args.flags.images = []; args.flags.images.push(argv[++i]); }
    else if (a === "--help" || a === "-h")              args.flags.help = true;
    i++;
  }
  return args;
}

async function main() {
  const { prompts, flags } = parseArgs(process.argv.slice(2));

  // ── Config commands (no API key needed) ──

  if (flags.getConfig) {
    const cfg = loadConfig();
    console.log(JSON.stringify({
      hasKey: !!cfg?.apiKey,
      keyPreview: cfg?.apiKey ? cfg.apiKey.slice(0, 8) + "..." + cfg.apiKey.slice(-4) : null,
      apiSite: cfg?.apiSite || null,
      apiBase: cfg ? resolveApiBase(cfg) : null,
      quickMode: cfg?.quickMode || null,
      batchMode: cfg?.batchMode || null,
    }, null, 2));
    process.exit(0);
  }

  if (flags.setSite) {
    const site = normalizeApiSite(flags.setSite);
    if (!site) {
      console.error('ERROR: --set-site must be "old" or "new".');
      process.exit(1);
    }
    const cfg = loadConfig() || {};
    cfg.apiSite = site;
    cfg.apiBase = API_SITES[site].base;
    saveConfig(cfg);
    console.log([
      `✅ 站点已保存！`,
      ``,
      `🌐 当前站点: ${API_SITES[site].label}`,
      `🔗 Host: ${API_SITES[site].host}`,
    ].join("\n"));
    process.exit(0);
  }

  if (flags.setKey) {
    const cfg = loadConfig() || {};
    cfg.apiKey = flags.setKey;
    saveConfig(cfg);
    const preview = flags.setKey.slice(0, 8) + "..." + flags.setKey.slice(-4);
    console.log(`✅ API Key 已保存！\n\n🔑 Key: ${preview}\n🔒 安全存储在本地，不会上传到任何地方`);
    process.exit(0);
  }

  if (flags.setQuickMode) {
    const cfg = loadConfig() || {};
    cfg.quickMode = {
      quality: (flags.quality || cfg.quickMode?.quality || DEFAULTS.quality).toUpperCase(),
      ratio:   (flags.ratio   || cfg.quickMode?.ratio   || DEFAULTS.ratio).toLowerCase(),
      count:   Math.max(1, Math.min(flags.count ?? cfg.quickMode?.count ?? DEFAULTS.count, 4)),
    };
    saveConfig(cfg);
    const q = cfg.quickMode.quality, r = cfg.quickMode.ratio;
    const s = resolveSize(q, r), n = cfg.quickMode.count;
    console.log([
      `✅ 设置完成！你的快速模式配置：`,
      ``,
      `🎨 画质: ${q} ${QUALITY_EMOJI[q] || ""}`,
      `📐 比例: ${RATIO_NAMES[r] || r} (${s})`,
      `🔢 每次: ${n} 张`,
      ``,
      `---`,
      ``,
      `💡 以后 @我 + 描述 → 直接出图，不用再选参数`,
      `⚙️ 随时说「修改配置」可以重新设置`,
      `📦 想一次生多张不同内容？说「批量生成」`,
    ].join("\n"));
    process.exit(0);
  }

  if (flags.setBatchMode) {
    const cfg = loadConfig() || {};
    cfg.batchMode = {
      quality:     (flags.quality     || cfg.batchMode?.quality     || DEFAULTS.quality).toUpperCase(),
      ratio:       (flags.ratio       || cfg.batchMode?.ratio       || DEFAULTS.ratio).toLowerCase(),
      concurrency: Math.max(1, Math.min(flags.concurrency ?? cfg.batchMode?.concurrency ?? DEFAULTS.concurrency, 10)),
    };
    saveConfig(cfg);
    const q = cfg.batchMode.quality, r = cfg.batchMode.ratio;
    const s = resolveSize(q, r), c = cfg.batchMode.concurrency;
    console.log([
      `✅ 批量模式已设置！`,
      ``,
      `🎨 画质: ${q} ${QUALITY_EMOJI[q] || ""}`,
      `📐 比例: ${RATIO_NAMES[r] || r} (${s})`,
      `⚡ 并发: ${c}`,
      ``,
      `💡 说「批量生成」+ 提示词列表即可开始`,
      `⚙️ 随时说「修改配置」可以调整`,
    ].join("\n"));
    process.exit(0);
  }

  if (flags.help || (prompts.length === 0 && !flags.batchFile && !flags.edit)) {
    printUsage();
    process.exit(0);
  }

  // ── Edit command ──

  if (flags.edit) {
    const images = flags.images || [];
    if (images.length === 0) { console.error("ERROR: --edit requires --image <path>"); process.exit(1); }
    if (prompts.length === 0) { console.error("ERROR: --edit requires --prompt <text>"); process.exit(1); }

    const apiKey = getApiKey();
    const cfg = loadConfig();
    const apiBase = resolveApiBase(cfg);
    const qm = cfg?.quickMode;
    const quality = (flags.quality || qm?.quality || DEFAULTS.quality).toUpperCase();
    const ratio = (flags.ratio || qm?.ratio || DEFAULTS.ratio).toLowerCase();
    const size = resolveSize(quality, ratio);
    if (!size) { console.error(`ERROR: Invalid quality="${quality}" or ratio="${ratio}".`); process.exit(1); }
    const outputDir = resolveOutputDir(flags.outputDir);

    if (images.length > 1) {
      const bm = cfg?.batchMode;
      const concurrency = Math.max(1, Math.min(flags.concurrency ?? bm?.concurrency ?? DEFAULTS.concurrency, 10));
      process.exit(await runBatchEdit(apiKey, images, prompts[0], size, concurrency, outputDir, apiBase));
    }

    const count = Math.max(1, Math.min(flags.count ?? 1, 4));

    if (count > 1) {
      const result = await editImage(apiKey, images[0], prompts[0], size, outputDir, apiBase, count);
      if (result.ok) {
        const NUM = ["①", "②", "③", "④"];
        const totalMB = result.results.reduce((sum, r) => sum + parseFloat(r.fileSize), 0).toFixed(2);
        console.log(`✏️ "${prompts[0]}" × ${count}\n`);
        console.log(`✅ ${(result.elapsed / 1000).toFixed(1)}s ｜ 共 ${totalMB}MB`);
        result.results.forEach((r, i) => console.log(`${NUM[i] || "·"} ${basename(r.path)}  ${r.fileSize}`));
        console.log(`📍 ${outputDir}`);
        console.log(`🖼️ 原图: ${result.sourceName}`);
      } else {
        console.error(`❌ 编辑失败: ${result.error}`);
        process.exit(1);
      }
      process.exit(0);
    }

    const result = await editImage(apiKey, images[0], prompts[0], size, outputDir, apiBase);
    if (result.ok) {
      console.log(`✏️ "${prompts[0]}"\n\n✅ ${(result.elapsed / 1000).toFixed(1)}s ｜ ${result.fileSize}\n📍 ${result.path}\n🖼️ 原图: ${result.sourceName}`);
    } else {
      console.error(`❌ 编辑失败: ${result.error}`);
      process.exit(1);
    }
    process.exit(0);
  }

  // ── Generation commands (need API key) ──

  const apiKey = getApiKey();
  const cfg = loadConfig();
  const apiBase = resolveApiBase(cfg);
  const isBatch = !!flags.batchFile || !!flags.batchInline;

  // Parameter resolution: explicit flag → mode config → hardcoded default
  let quality, ratio;
  if (isBatch) {
    const bm = cfg?.batchMode;
    quality = (flags.quality || bm?.quality || DEFAULTS.quality).toUpperCase();
    ratio   = (flags.ratio   || bm?.ratio   || DEFAULTS.ratio).toLowerCase();
  } else {
    const qm = cfg?.quickMode;
    quality = (flags.quality || qm?.quality || DEFAULTS.quality).toUpperCase();
    ratio   = (flags.ratio   || qm?.ratio   || DEFAULTS.ratio).toLowerCase();
  }

  const size = resolveSize(quality, ratio);
  if (!size) {
    console.error(`ERROR: Invalid quality="${quality}" or ratio="${ratio}".`);
    process.exit(1);
  }

  const outputDir = resolveOutputDir(flags.outputDir);

  // Batch from file
  if (flags.batchFile) {
    const bm = cfg?.batchMode;
    const concurrency = Math.max(1, Math.min(flags.concurrency ?? bm?.concurrency ?? DEFAULTS.concurrency, 10));
    const raw = readFileSync(flags.batchFile, "utf-8");
    const parsed = JSON.parse(raw);
    const bp = Array.isArray(parsed) ? parsed : parsed.prompts;
    if (!bp?.length) {
      console.error("ERROR: Batch file must be a JSON array of prompt strings.");
      process.exit(1);
    }
    process.exit(await runBatch(apiKey, bp, size, concurrency, outputDir, apiBase));
  }

  // Batch inline
  if (flags.batchInline && prompts.length >= 1) {
    const bm = cfg?.batchMode;
    const concurrency = Math.max(1, Math.min(flags.concurrency ?? bm?.concurrency ?? DEFAULTS.concurrency, 10));
    process.exit(await runBatch(apiKey, prompts, size, concurrency, outputDir, apiBase));
  }

  // Single prompt — resolve count from flag → quickMode config → default
  const prompt = prompts[0];
  const qm = cfg?.quickMode;
  const count = Math.max(1, Math.min(flags.count ?? qm?.count ?? DEFAULTS.count, 4));

  if (count > 1) {
    console.log();
    process.exit(await runBatch(apiKey, Array(count).fill(prompt), size, Math.min(count, 4), outputDir, apiBase, true));
  }

  // Single image
  console.log(`\n⏳ 生成中...\n`);

  const result = await generate(apiKey, prompt, size, outputDir, apiBase);
  if (result.ok) {
    console.log(`🎨 "${prompt}"\n\n✅ ${(result.elapsed / 1000).toFixed(1)}s ｜ ${result.fileSize}\n📍 ${result.path}`);
  } else {
    console.error(`❌ 生成失败: ${result.error}`);
    process.exit(1);
  }
}

// 仅在直接运行时执行 main，被 import 时不执行
import { fileURLToPath } from "node:url";
const __scriptPath = fileURLToPath(import.meta.url);
const __isMain = process.argv[1] && __scriptPath === resolve(process.argv[1]);
if (__isMain) {
  main();
}
