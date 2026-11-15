/**
 * 版本规则的唯一实现（供 CLI、自测脚本与发布流程共用）。
 *
 * 规则：
 * - 形式：`<major>.<minor>.<patch>`，可附加 `-alpha<序号>` 或 `-RC<序号>`；
 * - major 不限；minor 与 patch 取值为 0–10，出现 11 及以上直接判失败；
 * - alpha / RC 序号为正整数、不带前导零，且不受 10 的上限约束；
 * - 进位（`bumpVersion`）：
 *     patch 加 1 超过 10 → patch 归 0、minor 加 1；
 *     minor 加 1 超过 10 → minor 归 0、major 加 1；
 *     例：`1.0.10` 之后是 `1.1.0`，`1.10.10` 之后是 `2.0.0`；
 *     进位只作用于正式段位，预发布序号不参与。
 */

export const MAX_SEGMENT = 10;

export const PLATFORM_KEYS = ["windows-x86_64", "darwin-aarch64", "linux-x86_64"];

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|RC)(\d+))?$/;

function hasLeadingZero(text) {
  return text.length > 1 && text.startsWith("0");
}

/** 解析版本号；失败返回 { ok:false, reason }。 */
export function parseVersion(input) {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, reason: "版本号为空" };
  }
  const value = input.trim();
  const match = VERSION_RE.exec(value);
  if (!match) {
    return {
      ok: false,
      reason: `格式不合法：${value}（只接受 <major>.<minor>.<patch>，可附加 -alpha<序号> 或 -RC<序号>）`,
    };
  }
  const [, majorRaw, minorRaw, patchRaw, preKind, preRaw] = match;
  const reasons = [];

  for (const [label, raw] of [["major", majorRaw], ["minor", minorRaw], ["patch", patchRaw]]) {
    if (hasLeadingZero(raw)) reasons.push(`${label} 段不能有前导零：${raw}`);
  }
  if (preRaw !== undefined && hasLeadingZero(preRaw)) {
    reasons.push(`${preKind} 序号不能有前导零：${preRaw}`);
  }

  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const patch = Number(patchRaw);
  for (const [label, n] of [["minor", minor], ["patch", patch]]) {
    if (n > MAX_SEGMENT) {
      reasons.push(`${label} 段 ${n} 超过上限 ${MAX_SEGMENT}（例如 1.11.0 / 1.0.11 属于失败）`);
    }
  }
  if (preRaw !== undefined && Number(preRaw) < 1) {
    reasons.push(`${preKind} 序号必须为正整数：${preKind}${preRaw}`);
  }
  if (reasons.length > 0) return { ok: false, reason: reasons.join("；") };

  const prerelease = preRaw === undefined ? null : { kind: preKind, number: Number(preRaw) };
  return {
    ok: true,
    value,
    major,
    minor,
    patch,
    prerelease,
    isAlpha: preKind === "alpha",
    isRc: preKind === "RC",
    isPrerelease: prerelease !== null,
    base: `${major}.${minor}.${patch}`,
  };
}

/**
 * 按段位进位。`part` 取 `patch` / `minor` / `major`，默认 patch。
 * 返回与 `parseVersion` 同形的结果，预发布后缀在进位后丢弃。
 */
export function bumpVersion(input, part = "patch") {
  const parsed = parseVersion(input);
  if (!parsed.ok) return parsed;
  let { major, minor, patch } = parsed;

  if (part === "patch") {
    patch += 1;
    if (patch > MAX_SEGMENT) {
      patch = 0;
      minor += 1;
    }
    if (minor > MAX_SEGMENT) {
      minor = 0;
      major += 1;
    }
  } else if (part === "minor") {
    minor += 1;
    patch = 0;
    if (minor > MAX_SEGMENT) {
      minor = 0;
      major += 1;
    }
  } else if (part === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else {
    return { ok: false, reason: `未知段位：${part}（只接受 patch / minor / major）` };
  }

  return parseVersion(`${major}.${minor}.${patch}`);
}

/** tag 必须等于 `v<version>`。 */
export function checkTag(parsed, tag) {
  if (!parsed.ok) return parsed;
  if (!tag) return { ok: true };
  const expected = `v${parsed.value}`;
  if (tag !== expected) {
    return { ok: false, reason: `tag 与版本不一致：tag=${tag}，期望 ${expected}` };
  }
  return { ok: true };
}

/** latest.json 必须与版本文件同版本，且三个平台键齐全、带签名。 */
export function checkManifest(parsed, manifest) {
  if (!parsed.ok) return parsed;
  if (!manifest || typeof manifest !== "object") {
    return { ok: false, reason: "latest.json 无法解析" };
  }
  const reasons = [];
  if (manifest.version !== parsed.value) {
    reasons.push(`latest.json version=${manifest.version}，版本文件=${parsed.value}`);
  }
  const platforms = manifest.platforms;
  if (!platforms || typeof platforms !== "object") {
    reasons.push("latest.json 缺少 platforms");
  } else {
    for (const key of PLATFORM_KEYS) {
      const entry = platforms[key];
      if (!entry) {
        reasons.push(`latest.json 缺少平台 ${key}`);
        continue;
      }
      if (typeof entry.signature !== "string" || entry.signature.trim() === "") {
        reasons.push(`latest.json 的 ${key} 缺少 signature`);
      }
      if (typeof entry.url !== "string" || !entry.url.includes(`/download/v${parsed.value}/`)) {
        reasons.push(`latest.json 的 ${key} 下载地址与版本不一致：${entry.url}`);
      }
    }
  }
  if (reasons.length > 0) return { ok: false, reason: reasons.join("；") };
  return { ok: true };
}
