-- Unlist any workflow flagged as listed but missing a usable slug. A listed
-- workflow with a null, empty, or whitespace-only slug is discoverable in the
-- marketplace catalog yet uncallable: external agents invoke a listing by slug
-- at /api/mcp/workflows/<slug>/call, and there is no slug to address. The
-- save-time gate now refuses to create or keep such rows (it trims before
-- checking), so this one-time cleanup must match the same accept-shape and
-- unlist null/empty/whitespace slugs that predate the gate.
-- Data-only migration: no schema change.
UPDATE "workflows"
SET "is_listed" = false
WHERE "is_listed" = true
  AND ("listed_slug" IS NULL OR btrim("listed_slug") = '');
