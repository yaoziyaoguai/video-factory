export function unsplashPublicUrl(value: unknown, host: "unsplash.com" | "images.unsplash.com"): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== host || url.port || url.username || url.password) return undefined;
    if (host === "unsplash.com") {
      url.search = "utm_source=videofactory&utm_medium=referral";
      url.hash = "";
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export function UnsplashAttribution({ creator, creatorUrl }: { creator?: string | undefined; creatorUrl?: string | undefined }) {
  const profile = unsplashPublicUrl(creatorUrl, "unsplash.com");
  return <span>摄影：{profile && creator ? <a href={profile} target="_blank" rel="noreferrer">{creator}</a> : creator || "作者信息待核对"} · <a href="https://unsplash.com/?utm_source=videofactory&utm_medium=referral" target="_blank" rel="noreferrer">Unsplash</a></span>;
}
