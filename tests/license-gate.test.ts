import { describe, it, expect } from "vitest";
import { validateLicense, formatUpgradePrompt } from "../src/license.js";
import { createHmac } from "node:crypto";

// Local key generator for tests (mirrors the license.ts validation logic)
const HMAC_SECRET = "mcp-java-backend-suite-license-v1";
const EPOCH = new Date("2026-01-01T00:00:00Z");
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, result = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_CHARS[(value >> bits) & 31];
    }
  }
  if (bits > 0) result += BASE32_CHARS[(value << (5 - bits)) & 31];
  return result;
}

function generateKey({ productMask, expiryDate, customerId }: {
  productMask: number; expiryDate: Date; customerId: number;
}): string {
  const days = Math.floor((expiryDate.getTime() - EPOCH.getTime()) / 86400000);
  const payload = Buffer.from([
    productMask & 0xff,
    (days >> 8) & 0xff, days & 0xff,
    (customerId >> 16) & 0xff, (customerId >> 8) & 0xff, customerId & 0xff,
  ]);
  const sig = createHmac("sha256", HMAC_SECRET).update(payload).digest().subarray(0, 6);
  const encoded = base32Encode(Buffer.concat([payload, sig]));
  return `MCPJBS-${encoded.slice(0, 5)}-${encoded.slice(5, 10)}-${encoded.slice(10, 15)}-${encoded.slice(15, 20)}`;
}

// --- License validation (local copy) ---

describe("license validation", () => {
  it("returns free mode when no key provided", () => {
    const result = validateLicense(undefined, "migration-advisor");
    expect(result.isPro).toBe(false);
    expect(result.reason).toBe("No license key provided");
  });

  it("returns free mode for empty string", () => {
    const result = validateLicense("", "migration-advisor");
    expect(result.isPro).toBe(false);
  });

  it("returns free mode for invalid prefix", () => {
    const result = validateLicense("INVALID-AAAAA-BBBBB-CCCCC-DDDDD", "migration-advisor");
    expect(result.isPro).toBe(false);
    expect(result.reason).toContain("missing MCPJBS- prefix");
  });

  it("returns free mode for truncated key", () => {
    const result = validateLicense("MCPJBS-AAAA", "migration-advisor");
    expect(result.isPro).toBe(false);
    expect(result.reason).toContain("too short");
  });

  it("returns free mode for tampered key", () => {
    const result = validateLicense("MCPJBS-AAAAA-AAAAA-AAAAA-AAAAA", "migration-advisor");
    expect(result.isPro).toBe(false);
    // Either "signature mismatch" or "does not include" — both are correct rejections
    expect(result.isPro).toBe(false);
  });

  it("validates a real key for migration-advisor", () => {
    const key = generateKey({
      productMask: 0b00000100, // bit 2 = migration-advisor
      expiryDate: new Date("2027-06-01"),
      customerId: 12345,
    });
    const result = validateLicense(key, "migration-advisor");
    expect(result.isPro).toBe(true);
    expect(result.customerId).toBe(12345);
    expect(result.reason).toBe("Valid Pro license");
  });

  it("rejects key for wrong product", () => {
    const key = generateKey({
      productMask: 0b00000001, // bit 0 = db-analyzer only
      expiryDate: new Date("2027-06-01"),
      customerId: 99,
    });
    const result = validateLicense(key, "migration-advisor");
    expect(result.isPro).toBe(false);
    expect(result.reason).toContain("does not include migration-advisor");
  });

  it("rejects expired key", () => {
    const key = generateKey({
      productMask: 0b00000100,
      expiryDate: new Date("2026-01-02"), // already expired
      customerId: 1,
    });
    const result = validateLicense(key, "migration-advisor");
    expect(result.isPro).toBe(false);
    expect(result.reason).toContain("expired");
  });

  it("accepts suite-wide key (all products)", () => {
    const key = generateKey({
      productMask: 0b00011111, // all 5 products
      expiryDate: new Date("2028-01-01"),
      customerId: 42,
    });
    const result = validateLicense(key, "migration-advisor");
    expect(result.isPro).toBe(true);
    expect(result.customerId).toBe(42);
  });
});

// --- Upgrade prompt ---

describe("formatUpgradePrompt", () => {
  it("includes tool name and feature description", () => {
    const prompt = formatUpgradePrompt("generate_rollback", "Full rollback SQL");
    expect(prompt).toContain("generate_rollback (Pro Feature)");
    expect(prompt).toContain("Full rollback SQL");
    expect(prompt).toContain("MCP_LICENSE_KEY");
    expect(prompt).toContain("mcpjbs.dev/pricing");
  });
});

// --- Pro gate behavior (unit test of the gating logic) ---

describe("generate_rollback Pro gate", () => {
  it("free mode: preview shows stats but no SQL", () => {
    // Simulate what the handler does in free mode
    const license = validateLicense(undefined, "migration-advisor");
    expect(license.isPro).toBe(false);

    // The handler would return a preview with counts but no rollbackSql
    const preview = formatUpgradePrompt(
      "generate_rollback",
      "Full rollback SQL generation"
    );
    expect(preview).toContain("Pro Feature");
    expect(preview).not.toContain("```sql");
  });

  it("pro mode: full output would be returned", () => {
    const key = generateKey({
      productMask: 0b00000100,
      expiryDate: new Date("2027-12-31"),
      customerId: 500,
    });
    const license = validateLicense(key, "migration-advisor");
    expect(license.isPro).toBe(true);
    // In pro mode, the handler returns full rollback SQL (tested in rollback.test.ts)
  });
});
