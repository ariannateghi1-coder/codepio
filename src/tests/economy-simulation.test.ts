import { describe, expect, it } from "vitest";
import { simulateEconomy } from "@/lib/services/economy-simulation";
import { SIGNUP_GRANT_CREDITS, SUPPORT_TRANSFER_CREDITS } from "@/lib/gamification";

/**
 * Credit supply projection.
 *
 * The previous version of this suite asserted a net issuance of +600,000 credits
 * per day at 10,000 users and called that the expected baseline. That was the
 * measurement of an economy where every support minted currency. These tests pin
 * the opposite property: support activity cannot change the supply at all.
 */

describe("economy simulation", () => {
  it("issues credits ONLY through the signup grant", () => {
    const result = simulateEconomy({ users: 10_000, supportsPerUserPerDay: 20 });
    expect(result.issuance).toBe(10_000 * SIGNUP_GRANT_CREDITS);
    expect(result.netIssuance).toBe(result.issuance);
    expect(result.totalSupply).toBe(result.issuance);
  });

  it("keeps issuance independent of how much support activity happens", () => {
    const quiet = simulateEconomy({ users: 1_000, supportsPerUserPerDay: 0, days: 30 });
    const busy = simulateEconomy({ users: 1_000, supportsPerUserPerDay: 50, days: 30 });
    expect(busy.netIssuance).toBe(quiet.netIssuance);
    expect(busy.totalSupply).toBe(quiet.totalSupply);
    expect(busy.netPerSupport).toBe(0);
    expect(busy.conservative).toBe(true);
  });

  it("reports transfer volume without counting it as issuance", () => {
    const result = simulateEconomy({ users: 100, supportsPerUserPerDay: 2, days: 5 });
    expect(result.supports).toBe(1_000);
    expect(result.transferVolume).toBe(1_000 * SUPPORT_TRANSFER_CREDITS);
    // The volume moved is large; the supply is unmoved by it.
    expect(result.totalSupply).toBe(100 * SIGNUP_GRANT_CREDITS);
  });

  it("scales issuance with accounts, which is the only lever that grows supply", () => {
    const small = simulateEconomy({ users: 10, supportsPerUserPerDay: 5 });
    const large = simulateEconomy({ users: 20, supportsPerUserPerDay: 5 });
    expect(large.totalSupply).toBe(small.totalSupply * 2);
  });

  it("rejects negative inputs", () => {
    expect(() => simulateEconomy({ users: -1, supportsPerUserPerDay: 20 })).toThrow(RangeError);
    expect(() => simulateEconomy({ users: 1, supportsPerUserPerDay: 1, days: -3 })).toThrow(RangeError);
  });
});
