// Production entry point; development uses npm run dev.
process.env.NODE_ENV='production';
await import('./index.js');
