import "reflect-metadata";
import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import { openApiDocument } from "@lyonix/contracts/openapi";
import { AppModule } from "./app.module.js";
import { requestIdMiddleware } from "./request-id.js";
import { HttpErrorEnvelopeFilter } from "./http-exception.filter.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
config({ path: resolve(repoRoot, ".env") });
config({ path: resolve(repoRoot, ".env.local"), override: true });
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

const bootstrap = async () => {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api/v1");
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:5173", credentials: true });
  app.use(requestIdMiddleware);
  app.useGlobalFilters(new HttpErrorEnvelopeFilter());
  app.getHttpAdapter().get("/api/openapi.json", (_request, response) => {
    response.json(openApiDocument);
  });
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
};

void bootstrap();
