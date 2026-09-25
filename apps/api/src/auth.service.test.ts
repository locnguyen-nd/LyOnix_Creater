import { describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service.js";

const userBase = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  email: "new@example.com",
  displayName: "New User",
  role: "staff" as const,
  disabled: false,
  uiLocale: "vi",
  theme: "system",
  timezone: "Asia/Ho_Chi_Minh",
  version: 1,
};

function serviceWith(prisma: Record<string, unknown>) {
  const grants = { forUser: vi.fn().mockResolvedValue({ teamIds: [], projectIds: [], channelIds: [] }) };
  return new AuthService(prisma as never, grants as never);
}

describe("AuthService registration and approval", () => {
  it("creates public registrations as unapproved staff with a password hash", async () => {
    const create = vi.fn().mockResolvedValue({});
    const service = serviceWith({ user: { create } });

    await expect(service.register({ email: " Person@Example.com ", displayName: " New Person ", password: "strong-pass-8" })).resolves.toBe("created");
    const data = create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ email: "person@example.com", displayName: "New Person", role: "staff", approved: false });
    expect(data.passwordHash).not.toBe("strong-pass-8");
  });

  it("rejects weak passwords and malformed email before database writes", async () => {
    const create = vi.fn();
    const service = serviceWith({ user: { create } });
    await expect(service.register({ email: "bad", displayName: "User", password: "short" })).resolves.toBe("invalid");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not authenticate an unapproved account, even with the correct password", async () => {
    const { hashPassword } = await import("./password.js");
    const findUnique = vi.fn().mockResolvedValue({ ...userBase, approved: false, passwordHash: hashPassword("strong-pass-8") });
    const service = serviceWith({ user: { findUnique } });
    await expect(service.authenticate(userBase.email, "strong-pass-8")).resolves.toBe("pending");
  });
});
