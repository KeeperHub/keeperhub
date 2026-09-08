# ASN Enrichment for Behavioral Detection

Background for the deferred KEEP-612 alert "org-API-key use off-hours / from new ASN". The substrate ships today with country only; ASN needs a decision before it can land.

## What we have today

`workflow_executions.triggered_by_country` is populated from Cloudflare's `cf-ipcountry` header (ISO-3166-1 alpha-2). Free, always present on CF-proxied requests, no enrichment pipeline required. The country-drift alert dimension works on this directly: a `kh_*` API key that has only ever called from `US` and suddenly hits from `RU` is detectable with a per-key country-history table and a Loki/cron query.

The ticket asks for **ASN** specifically. ASN is a finer signal — same country but a different ISP or hosting provider (e.g. legitimate Comcast residential vs. AWS / OVH / Tor exit). Catches attackers who VPN through a US datacenter to defeat country-only detection.

## Why ASN is not in the substrate today

No free header carries ASN. The three reasonable sources:

### Option A — MaxMind GeoLite2-ASN

Free dataset (CC-BY-SA-4.0), MMDB format, updated weekly. ~6 MB download. The app would:
1. Pull the latest dataset on container start or via a sidecar to a shared volume
2. Load it into memory at startup with `@maxmind/geoip2-node`
3. Look up `cf-connecting-ip` to get `{ autonomousSystemNumber, autonomousSystemOrganization }`
4. Write to a new `triggered_by_asn` column (text or int)

**Pros**: free; deterministic; works offline; same data as most security tools
**Cons**: 6 MB in every pod's memory; weekly refresh cron; license attribution requirement
**Effort**: ~1 day — npm install + lookup helper + schema column + migration + threading into `buildAttribution`

### Option B — Cloudflare Enterprise `cf-ipcountry-asn` header

Cloudflare provides ASN as a header on Enterprise plans (and some Pro+ add-ons). Same shape as `cf-ipcountry` but the value is the ASN integer.

**Pros**: zero app code beyond reading another header; always-fresh; no in-pod memory
**Cons**: requires the CF account to be on Enterprise (significant cost increase) OR a paid add-on; vendor lock-in for an attribution dimension
**Effort**: minutes of app code, but contract negotiation upstream

### Option C — Hybrid (recommended)

Ship MaxMind now and read the CF header opportunistically:

```ts
function getRequestAsn(request: Request): { asn: number; org: string } | null {
  const cfAsn = request.headers.get("cf-ipcountry-asn");
  if (cfAsn && /^\d+$/.test(cfAsn)) {
    return { asn: Number(cfAsn), org: "cf-edge" };
  }
  const ip = getRequestSourceIp(request);
  return ip ? lookupMaxmindAsn(ip) : null;
}
```

If CF Enterprise gets enabled later, the code already prefers the header and the in-pod lookup becomes vestigial (delete in a follow-up).

## Recommendation

Go with **Option C** when behavioral alerting is a priority. Cost: ~1 day app work, ~6 MB pod memory, weekly cron to refresh the MMDB file. The country dimension I already shipped covers ~80% of the "from unusual location" detection use case; ASN closes the VPN/datacenter-exit gap.

If behavioral alerting is not yet on the roadmap, defer ASN until at least the new-country alert is producing useful signal — that will surface whether the country-only dimension is leaving real attacks undetected.

## Open questions before implementing

- **Refresh cadence**: MaxMind updates twice weekly. Daily cron is conservative; weekly is sufficient. Choose based on how much pod-restart churn a refresh causes.
- **Storage**: do we need `triggered_by_asn` (FK to a separate `asns` reference table for `(number, organization)`) or just text? Text is simpler, costs ~30 bytes/row on a hot table — fine for v1.
- **Behavioral alert query shape**: same pattern as the new-country alert — per-key `asns_seen` history, flag any new tuple.

## References

- MaxMind GeoLite2: https://dev.maxmind.com/geoip/geolite2-free-geolocation-data
- `@maxmind/geoip2-node`: https://github.com/maxmind/GeoIP2-node
- Cloudflare Enterprise headers (incl. ASN): https://developers.cloudflare.com/network/network-error-logging/configure/
