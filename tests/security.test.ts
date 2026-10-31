import { describe, expect, it } from "vitest";
import { constantTimeEqual, sha256, verifyMetaSignature } from "../worker/index";
import { accountUpdateAction } from "../worker/whatsapp";

async function signature(secret: string, raw: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return `sha256=${[...new Uint8Array(signed)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

describe("security primitives", () => {
  it("compares signatures without accepting length or content differences", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("hashes deterministically without exposing the input", async () => {
    const digest = await sha256("session-token");
    expect(digest).toHaveLength(64);
    expect(digest).not.toContain("session-token");
    expect(digest).toBe(await sha256("session-token"));
  });

  it("accepts only a valid Meta HMAC signature", async () => {
    const raw = '{"object":"whatsapp_business_account"}';
    const valid = new Request("https://example.com/api/webhooks/meta", {
      headers: { "x-hub-signature-256": await signature("app-secret", raw) },
    });
    const invalid = new Request("https://example.com/api/webhooks/meta", {
      headers: { "x-hub-signature-256": "sha256=invalid" },
    });
    await expect(verifyMetaSignature(valid, "app-secret", raw)).resolves.toBe(true);
    await expect(verifyMetaSignature(invalid, "app-secret", raw)).resolves.toBe(false);
  });
});

describe("WhatsApp account updates", () => {
  it("disconnects when the WhatsApp account is deleted", () => {
    expect(accountUpdateAction("ACCOUNT_DELETED", undefined, "app-123")).toBe(
      "disconnect",
    );
  });

  it("disconnects only when this app is uninstalled", () => {
    expect(
      accountUpdateAction("PARTNER_APP_UNINSTALLED", "app-123", "app-123"),
    ).toBe("disconnect");
    expect(
      accountUpdateAction("PARTNER_APP_UNINSTALLED", "other-app", "app-123"),
    ).toBe("record");
  });

  it("marks restrictions and offboarding for review without disconnecting", () => {
    for (const event of [
      "ACCOUNT_OFFBOARDED",
      "ACCOUNT_RESTRICTION",
      "ACCOUNT_VIOLATION",
      "DISABLED_UPDATE",
    ])
      expect(accountUpdateAction(event, undefined, "app-123")).toBe("error");
  });

  it("records other account updates without changing the connection", () => {
    expect(accountUpdateAction("PARTNER_APP_INSTALLED", "app-123", "app-123")).toBe(
      "record",
    );
    expect(accountUpdateAction(undefined, undefined, "app-123")).toBe("record");
  });
});
