#!/usr/bin/env node
/**
 * 用内嵌到应用的 minisign 公钥校验 Release 附件的 `.sig`。
 *
 * 用法：
 *   node scripts/verify-signature.mjs --pubkey <公钥文件或 base64> --file <已下载的安装包> --sig <安装包.sig>
 *
 * 公钥与 tauri.conf.json 的 plugins.updater.pubkey 相同（minisign 公钥的 base64）。
 * 签名校验标准 Ed25519 流程；兼容 minisign 的 "Ed"（直接签名）与 "ED"（BLAKE2b-512 预哈希）两种模式。
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const pubkeyArg = argOf("--pubkey");
const fileArg = argOf("--file");
const sigArg = argOf("--sig");
if (!pubkeyArg || !fileArg || !sigArg) {
  console.error("用法：node scripts/verify-signature.mjs --pubkey <路径|base64> --file <文件> --sig <签名>");
  process.exit(2);
}

function fail(message) {
  console.error(`[verify-signature] 失败：${message}`);
  process.exit(1);
}

/** 公钥：优先当文件读，读不到就按 base64 文本处理。 */
function readPubkey(input) {
  let text;
  try {
    text = readFileSync(input, "utf8").trim();
  } catch {
    text = input.trim();
  }
  const raw = Buffer.from(text, "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    fail("公钥不是合法的 minisign Ed25519 公钥（应为 base64 的 42 字节 Ed 结构）");
  }
  return { keyId: raw.subarray(2, 10), pub: raw.subarray(10, 42) };
}

/** 签名：Tauri 输出 base64(minisign 文本)，也兼容直接给 minisign 文本。 */
function readSignature(path) {
  const text = readFileSync(path, "utf8").trim();
  const decoded = text.startsWith("untrusted comment:")
    ? text
    : Buffer.from(text, "base64").toString("utf8");
  const lines = decoded.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sigLine = lines.find((line) => !line.startsWith("untrusted comment:") && !line.startsWith("trusted comment:"));
  if (!sigLine) fail(".sig 内容里找不到签名行");
  const raw = Buffer.from(sigLine, "base64");
  if (raw.length !== 74) fail(`签名长度异常：${raw.length} 字节（应为 74）`);
  const alg = raw.subarray(0, 2).toString("latin1");
  if (alg !== "Ed" && alg !== "ED") fail(`未知签名算法：${alg}`);
  return { alg, keyId: raw.subarray(2, 10), sig: raw.subarray(10, 74) };
}

const { keyId: expectedKeyId, pub } = readPubkey(pubkeyArg);
const { alg, keyId, sig } = readSignature(sigArg);
if (!keyId.equals(expectedKeyId)) {
  fail(`签名 keyId 与公钥不匹配：sig=${keyId.toString("hex")} pub=${expectedKeyId.toString("hex")}`);
}

const data = readFileSync(fileArg);
const message = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]);
const key = createPublicKey({ key: spki, format: "der", type: "spki" });
const ok = verify(null, message, key, sig);
if (!ok) fail(`${fileArg} 的签名校验未通过`);
console.log(`[verify-signature] 通过：${fileArg}（算法 ${alg}，keyId ${keyId.toString("hex")}）`);
