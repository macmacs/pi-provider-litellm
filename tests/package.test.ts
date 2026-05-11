import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("package gallery metadata", () => {
  it("uses the gallery image URL expected by pi.dev", async () => {
    const { default: manifest } = await import("../package.json", {
      with: { type: "json" },
    });

    expect(manifest.pi.image).toBe(
      "https://raw.githubusercontent.com/balcsida/pi-provider-litellm/refs/heads/main/assets/pi_litellm_gallery.png",
    );
  });

  it("does not expose the npm badge as gallery media", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).not.toContain("https://img.shields.io/npm/v/pi-provider-litellm.svg");
  });
});
