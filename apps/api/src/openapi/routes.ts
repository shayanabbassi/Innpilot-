import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AppModule } from '../app.module';
import { POLICY_KEY, type RoutePolicy } from '../auth/policy';
import type { AppConfig } from '../config';

export interface RouteInfo {
  /** e.g. "POST /users/{id}/roles" (OpenAPI path syntax, without the /api/v1 prefix). */
  key: string;
  method: string;
  path: string;
  handler: string;
  policy: RoutePolicy | undefined;
}

type Ctor = abstract new (...args: never[]) => unknown;

/** Every HTTP route the application exposes, read from Nest's decorator metadata. */
export function collectRoutes(): RouteInfo[] {
  const controllers = (AppModule.register({} as AppConfig).controllers ?? []) as Ctor[];
  return controllers.flatMap((controller) => {
    const proto = controller.prototype as Record<string, unknown>;
    return Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name] as object))
      .map((name) => {
        const handler = proto[name] as object;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]!;
        const path =
          '/' +
          [Reflect.getMetadata(PATH_METADATA, controller), Reflect.getMetadata(PATH_METADATA, handler)]
            .map(String)
            .filter((p) => p && p !== '/')
            .join('/')
            .replace(/:([A-Za-z]+)/g, '{$1}');
        const policy = (Reflect.getMetadata(POLICY_KEY, handler) ??
          Reflect.getMetadata(POLICY_KEY, controller)) as RoutePolicy | undefined;
        return { key: `${method} ${path}`, method, path, handler: `${controller.name}.${name}`, policy };
      });
  });
}

/** Human-readable access rule for documentation. */
export function describePolicy(policy: RoutePolicy): string {
  switch (policy.kind) {
    case 'public':
      return 'Public.';
    case 'session':
      return `Any signed-in session in state: ${policy.states.join(', ')}.`;
    case 'platform':
      return 'Platform operators only (operator session cookie; tenant sessions are refused).';
    case 'permission': {
      const scope =
        policy.scope === 'tenant'
          ? 'from a tenant-wide role'
          : policy.scope === 'any'
            ? 'on at least one property (results filtered per property)'
            : `on the property in path parameter \`${policy.scope.propertyParam}\``;
      return `Requires permission \`${policy.permission}\` ${scope}. Session must be fully verified (MFA).`;
    }
  }
}
