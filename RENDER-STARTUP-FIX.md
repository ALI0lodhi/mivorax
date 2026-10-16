# Render port-binding fix

The database connected, but Render could not detect an open port on 0.0.0.0. The previous listener defaulted to 127.0.0.1 and also printed a hardcoded localhost URL. It could therefore remain inaccessible when HOST was absent or copied from local development.

Production now always binds to 0.0.0.0, including when HOST=127.0.0.1 was accidentally supplied. The API uses the PORT provided by Render, with 4000 only as the fallback. Local development still defaults to loopback. The startup message reports the actual bound address and port. Invalid ports fail before database startup.

Verified listener configuration and an actual HTTP request to a production-style 0.0.0.0 listener in the security test suite.

Commit and push src/index.js, src/listen-options.js, test/security.test.js and this document, then redeploy the latest commit on Render. Build command remains npm ci; start command remains npm start. Remove any manually configured PORT to use Render's default, or keep a valid custom PORT. HOST no longer needs to be set in production.

The missing .env notice is expected when Render provides dashboard environment variables. The log's database name test is separate from port binding: include /mivorax in MONGODB_URI if that is the intended Atlas database. Changing the database name does not migrate local content or create an admin account.

Reference: https://render.com/docs/web-services#port-binding
