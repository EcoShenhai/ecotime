// Own database and limited role only (P5). Never an administrator role or the shared default database.
import fs from 'node:fs';
import { Sequelize } from 'sequelize';

export function createSequelize(cfg) {
  if (/^(doadmin|postgres)$/i.test(cfg.db.user) || /^defaultdb$/i.test(cfg.db.name)) throw new Error('Refusing an administrator role or the shared default database (E2)');
  const ssl = cfg.db.ssl ? (cfg.db.sslCaFile ? { require: true, ca: fs.readFileSync(cfg.db.sslCaFile, 'utf8') } : { require: true, rejectUnauthorized: false }) : false;
  return new Sequelize(cfg.db.name, cfg.db.user, cfg.db.password, {
    host: cfg.db.host, port: cfg.db.port, dialect: 'postgres', logging: false, dialectOptions: ssl ? { ssl } : {},
    pool: { max: cfg.db.poolMax, min: 0, idle: 10000, acquire: 20000 },
    define: { underscored: true, timestamps: false, freezeTableName: true },
  });
}
