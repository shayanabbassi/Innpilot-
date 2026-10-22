import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { json, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule, type AppOptions } from './app.module';
import type { AppConfig } from './config';
import { routeTemplate } from './common/error.filter';
import { MetricsService } from './monitoring/metrics.service';

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
  // Request latency and status by route template, for the metrics (6.6).
  const metrics = app.get(MetricsService);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      metrics.observeRequest(req.method, routeTemplate(req), res.statusCode, seconds);
    });
    next();
  });
  app.use(helmet());
  app.use(json({ limit: '100kb' }));
  app.use(cookieParser());
  app.enableCors({ origin: config.WEB_ORIGINS, credentials: true });
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  return app;
}
