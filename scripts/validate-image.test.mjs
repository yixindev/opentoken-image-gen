#!/usr/bin/env node

/**
 * 安全校验测试 — validateImageFile()
 * 使用 node:test 内置框架，零外部依赖
 *
 * 运行: node AiMaMi/plugins/opentoken-image-gen/scripts/validate-image.test.mjs
 */

import { describe, it, before, after } from "node:test";
import { strictEqual, ok } from "node:assert";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── 从 generate.mjs 导入待测函数（先实现后取消注释） ──
// 目前直接 import 会失败，这正是 TDD 的 RED 阶段
import { validateImageFile } from "./generate.mjs";

// ── 测试临时目录 ──
const TEST_DIR = join(tmpdir(), "opentoken-image-gen-security-test");
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// ── 魔术字节常量 ──
const MAGIC = {
  PNG: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  JPEG: Buffer.from([0xff, 0xd8, 0xff]),
  WEBP_RIFF: Buffer.from([0x52, 0x49, 0x46, 0x46]), // RIFF
  WEBP_MARKER: Buffer.from([0x57, 0x45, 0x42, 0x50]), // WEBP at offset 8
};

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════
// Layer 1: 扩展名白名单
// ══════════════════════════════════════════════════

describe("Layer 1: 扩展名白名单", () => {
  it("应接受 .png 扩展名", () => {
    const f = join(TEST_DIR, "ok.png");
    writeFileSync(f, MAGIC.PNG);
    const r = validateImageFile(f);
    ok(r.valid, r.reason);
  });

  it("应接受 .jpg 扩展名", () => {
    const f = join(TEST_DIR, "ok.jpg");
    writeFileSync(f, MAGIC.JPEG);
    const r = validateImageFile(f);
    ok(r.valid, r.reason);
  });

  it("应接受 .jpeg 扩展名", () => {
    const f = join(TEST_DIR, "ok.jpeg");
    writeFileSync(f, MAGIC.JPEG);
    const r = validateImageFile(f);
    ok(r.valid, r.reason);
  });

  it("应接受 .webp 扩展名", () => {
    // 构造最小 WebP: RIFF(4) + size(4) + WEBP(4) + padding
    const buf = Buffer.alloc(20);
    MAGIC.WEBP_RIFF.copy(buf, 0);
    buf.writeUInt32LE(12, 4); // chunk size
    MAGIC.WEBP_MARKER.copy(buf, 8);
    const f = join(TEST_DIR, "ok.webp");
    writeFileSync(f, buf);
    const r = validateImageFile(f);
    ok(r.valid, r.reason);
  });

  it("应拒绝无扩展名文件（如 id_rsa）", () => {
    const f = join(TEST_DIR, "id_rsa");
    writeFileSync(f, "-----BEGIN RSA PRIVATE KEY-----\n...");
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
    ok(r.reason.includes("扩展名"), `错误信息应提及扩展名, got: ${r.reason}`);
  });

  it("应拒绝 .txt 文件", () => {
    const f = join(TEST_DIR, "secrets.txt");
    writeFileSync(f, "password=123456");
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
    ok(r.reason.includes("扩展名"), `错误信息应提及扩展名, got: ${r.reason}`);
  });

  it("应拒绝 .json 文件", () => {
    const f = join(TEST_DIR, "credentials.json");
    writeFileSync(f, '{"apiKey":"sk-xxx"}');
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
    ok(r.reason.includes("扩展名"), `错误信息应提及扩展名, got: ${r.reason}`);
  });
});

// ══════════════════════════════════════════════════
// Layer 2: 文件头魔术字节校验
// ══════════════════════════════════════════════════

describe("Layer 2: 文件头魔术字节校验", () => {
  it("应拒绝扩展名是 .png 但内容不是 PNG 的文件", () => {
    const f = join(TEST_DIR, "fake.png");
    writeFileSync(f, "THIS IS NOT A PNG IMAGE");
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
    ok(r.reason.includes("文件头") || r.reason.includes("格式"), `错误信息应提及文件头/格式, got: ${r.reason}`);
  });

  it("应拒绝扩展名是 .jpg 但内容不是 JPEG 的文件", () => {
    const f = join(TEST_DIR, "fake.jpg");
    writeFileSync(f, "THIS IS NOT A JPEG IMAGE");
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
    ok(r.reason.includes("文件头") || r.reason.includes("格式"), `错误信息应提及文件头/格式, got: ${r.reason}`);
  });

  it("应拒绝扩展名是 .webp 但内容不是 WebP 的文件", () => {
    const f = join(TEST_DIR, "fake.webp");
    writeFileSync(f, "THIS IS NOT A WEBP IMAGE");
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
    ok(r.reason.includes("文件头") || r.reason.includes("格式"), `错误信息应提及文件头/格式, got: ${r.reason}`);
  });

  it("应接受合法的 PNG 文件（扩展名+文件头均匹配）", () => {
    const f = join(TEST_DIR, "real.png");
    writeFileSync(f, MAGIC.PNG);
    const r = validateImageFile(f);
    ok(r.valid, r.reason);
  });

  it("应接受合法的 JPEG 文件（扩展名+文件头均匹配）", () => {
    const f = join(TEST_DIR, "real.jpg");
    writeFileSync(f, MAGIC.JPEG);
    const r = validateImageFile(f);
    ok(r.valid, r.reason);
  });
});

// ══════════════════════════════════════════════════
// Layer 3: 文件大小上限
// ══════════════════════════════════════════════════

describe("Layer 3: 文件大小上限", () => {
  it("应拒绝超过 20MB 的文件", () => {
    // 创建一个扩展名合法但超大的文件
    const f = join(TEST_DIR, "huge.png");
    // 写 PNG 魔术字节 + 填充到 20MB + 1字节
    const buf = Buffer.alloc(MAX_FILE_SIZE + 1);
    MAGIC.PNG.copy(buf, 0);
    writeFileSync(f, buf);
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
    ok(r.reason.includes("大小") || r.reason.includes("MB"), `错误信息应提及文件大小, got: ${r.reason}`);
  });

  it("应接受小于 20MB 的文件", () => {
    const f = join(TEST_DIR, "small.png");
    writeFileSync(f, MAGIC.PNG);
    const r = validateImageFile(f);
    ok(r.valid, r.reason);
  });
});

// ══════════════════════════════════════════════════
// Layer 4: 路径穿越检测
// ══════════════════════════════════════════════════

describe("Layer 4: 路径穿越检测", () => {
  it("应拒绝包含 ../ 的路径", () => {
    const f = join(TEST_DIR, "..", "..", "etc", "passwd.png");
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
    ok(r.reason.includes("路径"), `错误信息应提及路径, got: ${r.reason}`);
  });

  it("应拒绝包含编码路径穿越的路径（%2e%2e%2f）", () => {
    const f = join(TEST_DIR, "%2e%2e%2fetc%2fpasswd.png");
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
    ok(r.reason.includes("路径"), `错误信息应提及路径, got: ${r.reason}`);
  });
});

// ══════════════════════════════════════════════════
// 综合攻击场景
// ══════════════════════════════════════════════════

describe("综合攻击场景", () => {
  it("应拒绝读取 ~/.ssh/id_rsa（无扩展名）", () => {
    const f = join(TEST_DIR, "id_rsa");
    writeFileSync(f, "-----BEGIN RSA PRIVATE KEY-----\n...");
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
  });

  it("应拒绝读取伪装为 .png 的私钥文件", () => {
    const f = join(TEST_DIR, "id_rsa.png");
    writeFileSync(f, "-----BEGIN RSA PRIVATE KEY-----\n...");
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
  });

  it("应拒绝读取 .aws/credentials.json", () => {
    const f = join(TEST_DIR, "credentials.json");
    writeFileSync(f, '[default]\naws_access_key_id=AKIA...');
    const r = validateImageFile(f);
    strictEqual(r.valid, false);
  });
});
