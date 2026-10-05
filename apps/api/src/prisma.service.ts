import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "@lyonix/db";
import { resolveDatabasePool } from "./database-url.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    const pool = resolveDatabasePool();
    if (pool.warning) console.warn(`[database] ${pool.warning}`);
    super(pool.url ? { datasources: { db: { url: pool.url } } } : undefined);
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
