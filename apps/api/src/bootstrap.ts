import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule, type AppOptions } from './app.module';
import type { AppConfig } from './config';

export const API_PREFIX = 'api/v1';

/** Builds the configured application. Shared by main.ts and the end-to-end tests. */
export async function createApp(
  config: AppConfig,
  options: { logger?: boolean } & AppOptions = {},
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(config, { logStream: options.logStream }),
    {
      bufferLogs: true,
      bodyParser: false,
      logger: options.logger === false ? false : undefined,
    },
  );
  if (options.logger !== false) {
    app.useLogger(app.get(Logger));
    // Nest only flushes buffered logs in listen(). Flush now, or an app started with init() (the tests)
    // keeps buffering every Nest Logger line and never writes it.
    app.flushLogs();
  }

  const trustProxy = config.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(json({ limit: '100kb' }));
  app.use(cookieParser());
  app.enableCors({ origin: config.WEB_ORIGINS, credentials: true });
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  return app;
}
