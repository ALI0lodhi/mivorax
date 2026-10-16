# MIVORAX API

Independent Node.js + Express + MongoDB application. It serves JSON and GridFS images only, with no dependency on the frontend directory.

```sh
npm ci
# Copy .env.example to .env and configure it.
npm run seed
npm start
```

Requires Node.js 22.12+. Configure `MONGODB_URI`, `JWT_SECRET`, `CLIENT_ORIGINS`, `HOST`, and `PORT`. Set `HOST=0.0.0.0` on hosts that require public binding. Use a MongoDB replica set or Atlas for transaction-safe checkout. Seed administrator credentials are required only during initial provisioning.

Public content is database-only. Without MongoDB, content endpoints return 503. Seed content cannot be ordered. Checkout stays closed until explicitly enabled by an administrator.

For the configured local database, first run `npm run db:local` in a separate terminal. It uses the installed MongoDB Server and persists data under `.local-db/` on port 27018. Compass URI: `mongodb://127.0.0.1:27018/mivorax?replicaSet=mivorax-rs`.

`npm test` runs unit tests. `npm run test:integration` exercises the API against an isolated, randomly named database on the configured replica set. See the root README for admin controls, deployment, security and remaining brief work.
