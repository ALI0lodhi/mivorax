# Atlas migration — 17 October 2026

Copied the existing local mivorax database to the user-provided Atlas cluster's explicit mivorax database. Atlas was verified empty before migration. The local source was read under snapshot isolation; target inserts were committed in one transaction after copying indexes. All collection counts were checked after commit. Existing IDs, object references, archived/draft status, administrator password hash and image links were preserved.

Migrated: 1 store settings record, 1 website record, 5 product records (including archived products), 3 categories, 1 collection, 8 pages, 2 posts, 1 admin, 28 audit entries, 1 GridFS image file and its 2 chunks. There were no orders, subscribers, reviews or coupons. Admin sessions and rate-limit records were excluded.

A protected BSON snapshot and count manifest were saved inside the ignored .security directory. The local database remains unchanged. The target URI is stored only in the ignored .env file; it is not included in this document or source.

The local DNS provider refused Atlas SRV lookups. The migration used process-only public DNS resolvers; it did not alter Windows DNS configuration or disable TLS checks.

## Render configuration

Set the private Render MONGODB_URI to the Atlas URI with the explicit `/mivorax` path before its query string. A URI ending in `/` selects the default `test` database, which is different from the migrated database. Save the environment change and redeploy. The connection log should report `MongoDB connected: mivorax`.

The database password was shared in chat. Rotate it in Atlas, then update Render and any retained private local target URI. Do not paste the replacement password into chat or commit it. Existing website admin credentials are independent and were preserved.

## Migration utility

src/migrate-atlas.js defaults to a dry run and refuses a nonempty target. It requires local source MONGODB_URI and an Atlas MONGODB_TARGET_URI with explicit database mivorax. `--apply` performs the migration; it has already been run successfully. Do not rerun it on the populated destination. `--dns=1.1.1.1,8.8.8.8` optionally sets the migration process's DNS servers.
