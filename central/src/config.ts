// Runtime configuration from the environment. See .env.example.

function readTls(): { key: string; cert: string } | undefined {
  const key = process.env['CENTRAL_TLS_KEY'];
  const cert = process.env['CENTRAL_TLS_CERT'];
  if (key && cert) return { key, cert };
  return undefined;
}

export const config = {
  port: Number(process.env['PORT'] ?? 4500),
  databaseUrl: process.env['DATABASE_URL'] ?? '',
  tls: readTls(),
};

export function requireDatabaseUrl(): string {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set (see central/.env.example)');
  }
  return config.databaseUrl;
}
