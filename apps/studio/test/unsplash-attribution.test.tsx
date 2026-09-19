import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnsplashAttribution, unsplashPublicUrl } from "../src/client/components/UnsplashAttribution.js";

describe("Unsplash attribution", () => {
  it("does not link untrusted or credential-bearing profile URLs", () => {
    render(<UnsplashAttribution creator="Photographer" creatorUrl="https://unsplash.com.attacker.test/profile" />);
    expect(screen.queryByRole("link", { name: "Photographer" })).not.toBeInTheDocument();
    for (const value of ["javascript:alert(1)", "https://secret@unsplash.com/profile", "https://unsplash.com:8443/profile"]) {
      expect(unsplashPublicUrl(value, "unsplash.com")).toBeUndefined();
    }
  });
  it("preserves the CDN image parameters and adds required referral credit", () => {
    expect(unsplashPublicUrl("https://images.unsplash.com/photo-1?w=400&ixid=view", "images.unsplash.com"))
      .toBe("https://images.unsplash.com/photo-1?w=400&ixid=view");
    expect(unsplashPublicUrl("https://unsplash.com/@photo", "unsplash.com"))
      .toBe("https://unsplash.com/@photo?utm_source=videofactory&utm_medium=referral");
  });
});
