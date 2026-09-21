import { UnsplashAttribution } from "./UnsplashAttribution.js";

export function hasStockAttribution(provider?: string): boolean {
  return ["coverr", "wikimedia", "unsplash", "met", "nasa", "openverse", "cleveland", "archive", "flickr"].some((name) => provider === name || provider === `${name}-stock-v1`);
}

export function stockPublicUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return undefined;
    const coverr = ["coverr.co", "cdn.coverr.co", "storage.coverr.co"].includes(url.hostname);
    const wikimedia = ["commons.wikimedia.org", "upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname);
    const openStock = ["www.metmuseum.org", "metmuseum.org", "images.metmuseum.org", "images.nasa.gov", "images-assets.nasa.gov", "api.openverse.org", "openverse.org", "clevelandart.org", "www.clevelandart.org", "openaccess-cdn.clevelandart.org"].includes(url.hostname);
    if (openStock && !url.search) return url.toString();
    if (["www.flickr.com", "live.staticflickr.com"].includes(url.hostname) && !url.search) return url.toString();
    if (url.hostname === "archive.org" && !url.search && /^\/(download|details)\//.test(url.pathname)) return url.toString();
    if (coverr && !url.search) return url.toString();
    if (wikimedia && [...url.searchParams.keys()].every((key) => ["utm_source", "utm_campaign", "utm_content"].includes(key))) return url.toString();
  } catch { /* 不把外部元数据里的非法链接交给浏览器。 */ }
  return undefined;
}

/** 原站链接只由用户点击，不作为任意远程缩略图加载。 */
export function stockSourceUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const known = stockPublicUrl(value);
  if (known) return known;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash
      || !host.includes(".") || host.includes(":") || /^[\d.]+$/.test(host)
      || /\.(local|internal|localhost)$/.test(host)
      || [...url.searchParams.keys()].some((key) => !["curid", "id", "v"].includes(key))) return undefined;
    return url.toString();
  } catch { return undefined; }
}

export function StockAttribution({ provider, creator, creatorUrl, licenseNote }: {
  provider?: string | undefined;
  creator?: string | undefined;
  creatorUrl?: string | undefined;
  licenseNote?: string | undefined;
}) {
  if (provider === "unsplash" || provider === "unsplash-stock-v1") return <UnsplashAttribution creator={creator} creatorUrl={creatorUrl} />;
  const coverr = provider === "coverr" || provider === "coverr-stock-v1";
  const sources: Record<string, { label: string; url: string }> = {
    met: { label: "The Met", url: "https://www.metmuseum.org" },
    cleveland: { label: "Cleveland Museum of Art", url: "https://www.clevelandart.org" },
    archive: { label: "Internet Archive", url: "https://archive.org/details/stock_footage" },
    flickr: { label: "Flickr", url: "https://www.flickr.com" },
    nasa: { label: "NASA", url: "https://images.nasa.gov" },
    openverse: { label: "Openverse", url: "https://openverse.org" },
    wikimedia: { label: "Wikimedia Commons", url: "https://commons.wikimedia.org" },
  };
  const source = sources[provider?.replace(/-stock-v1$/, "") ?? ""];
  const profile = stockSourceUrl(creatorUrl);
  return <span className="stock-attribution">
    作者：{profile && creator ? <a href={profile} target="_blank" rel="noreferrer">{creator}</a> : creator || "作者信息待核对"} · {coverr
      ? <a href="https://coverr.co" target="_blank" rel="noreferrer"><img src="/media/coverr-logo.svg" width="78" height="16" alt="Coverr" style={{ display: "inline-block", width: 78, height: 16, verticalAlign: "middle", background: "white", objectFit: "contain" }} /></a>
      : source ? <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a> : null}
    {licenseNote ? <span> · {licenseNote}</span> : null}
  </span>;
}
