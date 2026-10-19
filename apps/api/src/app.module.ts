import { randomUUID } from 'node:crypto';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { SessionService } from './auth/session.service';
import { EnvelopeInterceptor } from './common/envelope.interceptor';
import { ErrorFilter } from './common/error.filter';
import { APP_CONFIG, type AppConfig } from './config';
import { DayCloseController } from './day-close/day-close.controller';
import { DayCloseService } from './day-close/day-close.service';
import { DbModule } from './db/db.module';
import { HealthController } from './health/health.controller';
import { HousekeepingController } from './housekeeping/housekeeping.controller';
import { HousekeepingService } from './housekeeping/housekeeping.service';
import { MaintenanceService } from './housekeeping/maintenance.service';
import { IdempotencyService } from './idempotency/idempotency.service';
import { PropertiesController } from './properties/properties.controller';
import { GuestsController } from './guests/guests.controller';
import { GuestsService } from './guests/guests.service';
import { PiiService } from './guests/pii.service';
import { ReservationsController } from './reservations/reservations.controller';
import { ReservationsService } from './reservations/reservations.service';
import { RoomsController } from './rooms/rooms.controller';
import { StaysController } from './stays/stays.controller';
import { StaysService } from './stays/stays.service';
import { RoomsService } from './rooms/rooms.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;

/** Paths whose values must never appear in logs. */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.password_hash',
  '*.token',
  '*.code',
  '*.secret',
  '*.mfaSecretEnc',
  '*.number',
  '*.numberEnc',
  '*.document',
];

@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        {
          module: ConfigHolder,
          global: true,
          providers: [{ provide: APP_CONFIG, useValue: config }],
          exports: [APP_CONFIG],
        },
        LoggerModule.forRoot({
          pinoHttp: {
            level: config.LOG_LEVEL,
            genReqId: (req, res) => {
              const incoming = req.headers['x-request-id'];
              const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
              res.setHeader('x-request-id', id);
              return id;
            },
            redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
            serializers: {
              // Log the path without the query string; queries can carry search terms with guest details.
              req: (req: { id: string; method: string; url: string }) => ({
                id: req.id,
                method: req.method,
                path: req.url.split('?')[0],
              }),
            },
            customProps: (req) => {
              const auth = (req as { auth?: { tenantId: string; userId: string } }).auth;
              return auth ? { tenantId: auth.tenantId, userId: auth.userId } : {};
            },
          },
        }),
        ThrottlerModule.forRoot({
          throttlers: [{ name: 'default', ttl: 60_000, limit: 300 }],
          skipIf: () => !config.RATE_LIMIT_ENABLED,
        }),
        DbModule,
      ],
      controllers: [
        AuthController,
        PropertiesController,
        RoomsController,
        GuestsController,
        ReservationsController,
        StaysController,
        HousekeepingController,
        DayCloseController,
        UsersController,
        AuditController,
        HealthController,
      ],
      providers: [
        // Order matters: rate limiting runs before authentication.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ErrorFilter },
        { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
        AuditService,
        AuthService,
        SessionService,
        UsersService,
        RoomsService,
        GuestsService,
        ReservationsService,
        StaysService,
        HousekeepingService,
        MaintenanceService,
        DayCloseService,
        PiiService,
        IdempotencyService,
      ],
    };
  }
}

@Module({})
class ConfigHolder {}
