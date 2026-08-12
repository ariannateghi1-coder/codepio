import { describe, expect, it } from "vitest";
import {
  extractYoutubeChannelId,
  extractYoutubeVideoId,
  formatDuration,
  isValidYoutubeChannelId,
  isValidYoutubeVideoId,
  parseIsoDuration,
  youtubeEmbedUrl,
  youtubeWatchUrl,
} from "@/lib/youtube";

/**
 * URL parsing is a security boundary here: a hostname check that accepts
 * `evil-youtube.com` would let an attacker register arbitrary content as a
 * YouTube video, so the host allow-list is tested explicitly.
 */

describe("extractYoutubeVideoId — accepted forms", () => {
  const cases: [string, string][] = [
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/v/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "dQw4w9WgXcQ"],
    ["  https://youtu.be/dQw4w9WgXcQ  ", "dQw4w9WgXcQ"],
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ];

  it.each(cases)("accepts %s", (input, expected) => {
    expect(extractYoutubeVideoId(input)).toBe(expected);
  });
});

describe("extractYoutubeVideoId — rejected forms", () => {
  const rejected = [
    // Look-alike hosts: the exact reason an allow-list is used instead of endsWith.
    "https://evil-youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com.attacker.net/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be.attacker.net/dQw4w9WgXcQ",
    // Wrong scheme / injection attempts.
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    // Malformed ids.
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=waytoolongvideoid123",
    "https://www.youtube.com/watch?v=bad!chars@@",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/",
    "",
    "not a url at all",
  ];

  it.each(rejected)("rejects %s", (input) => {
    expect(extractYoutubeVideoId(input)).toBeNull();
  });

  it("rejects an absurdly long input without scanning it all", () => {
    expect(extractYoutubeVideoId("https://youtu.be/" + "a".repeat(5000))).toBeNull();
  });
});

describe("video id validation", () => {
  it("requires exactly 11 URL-safe characters", () => {
    expect(isValidYoutubeVideoId("dQw4w9WgXcQ")).toBe(true);
    expect(isValidYoutubeVideoId("dQw4w9WgXc")).toBe(false);
    expect(isValidYoutubeVideoId("dQw4w9WgXcQQ")).toBe(false);
    expect(isValidYoutubeVideoId("dQw4w9WgX Q")).toBe(false);
  });
});

describe("channel ids", () => {
  const valid = "UC" + "a".repeat(22);

  it("validates the canonical UC-prefixed form", () => {
    expect(isValidYoutubeChannelId(valid)).toBe(true);
    expect(isValidYoutubeChannelId("UCshort")).toBe(false);
    expect(isValidYoutubeChannelId("XX" + "a".repeat(22))).toBe(false);
  });

  it("extracts an id from a /channel/ URL", () => {
    expect(extractYoutubeChannelId(`https://www.youtube.com/channel/${valid}`)).toBe(valid);
  });

  it("returns null for handle URLs, which do not contain the canonical id", () => {
    expect(extractYoutubeChannelId("https://www.youtube.com/@somehandle")).toBeNull();
    expect(extractYoutubeChannelId("https://www.youtube.com/c/somename")).toBeNull();
    expect(extractYoutubeChannelId("https://www.youtube.com/user/somename")).toBeNull();
  });

  it("rejects a look-alike host", () => {
    expect(extractYoutubeChannelId(`https://evil-youtube.com/channel/${valid}`)).toBeNull();
  });
});

describe("url builders", () => {
  it("builds a canonical watch url", () => {
    expect(youtubeWatchUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("always embeds through youtube-nocookie, matching the CSP frame-src", () => {
    const url = youtubeEmbedUrl("dQw4w9WgXcQ", { origin: "https://app.example", enableJsApi: true });
    expect(url.startsWith("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?")).toBe(true);
    expect(url).toContain("enablejsapi=1");
    expect(url).toContain("origin=https%3A%2F%2Fapp.example");
  });
});

describe("parseIsoDuration", () => {
  it("parses hours, minutes and seconds", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT3M33S")).toBe(213);
    expect(parseIsoDuration("PT19S")).toBe(19);
    expect(parseIsoDuration("P1DT1H")).toBe(90000);
  });

  it("returns null for unparsable or zero-length input", () => {
    expect(parseIsoDuration("nonsense")).toBeNull();
    expect(parseIsoDuration("PT0S")).toBeNull();
  });
});

describe("formatDuration", () => {
  it("omits the hour component when it is zero", () => {
    expect(formatDuration(213)).toBe("3:33");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(9)).toBe("0:09");
    expect(formatDuration(-5)).toBe("0:00");
  });
});
