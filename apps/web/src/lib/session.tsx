'use client';

import type { MeResponse, Permission, PropertyAccess } from '@innpilot/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

export const ME_QUERY_KEY = ['auth', 'me'] as const;
const PROPERTY_STORAGE_KEY = 'innpilot.propertyId';

export function useMe() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: () => api.get<MeResponse>('/auth/me'),
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    staleTime: 60_000,
  });
}

interface SessionValue {
  me: MeResponse;
  property: PropertyAccess | null;
  setPropertyId(id: string): void;
  /** For showing or hiding controls only. The API enforces every permission itself. */
  can(permission: Permission): boolean;
  /** True if a tenant-wide role grants the permission (staff admin, audit log). */
  canTenant(permission: Permission): boolean;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

function readStoredProperty(): string | null {
  try {
    return localStorage.getItem(PROPERTY_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function SessionProvider({ me, children }: { me: MeResponse; children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [propertyId, setPropertyIdState] = useState<string | null>(null);

  useEffect(() => {
    setPropertyIdState(readStoredProperty());
  }, []);

  const property = me.properties.find((p) => p.id === propertyId) ?? me.properties[0] ?? null;

  const setPropertyId = useCallback((id: string) => {
    setPropertyIdState(id);
    try {
      localStorage.setItem(PROPERTY_STORAGE_KEY, id);
    } catch {
      // Storage unavailable (private mode); the choice simply is not remembered.
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      queryClient.clear();
      router.replace('/login');
    }
  }, [queryClient, router]);

  const value = useMemo<SessionValue>(
    () => ({
      me,
      property,
      setPropertyId,
      can: (p) => property?.permissions.includes(p) ?? false,
      canTenant: (p) => me.tenantPermissions.includes(p),
      signOut,
    }),
    [me, property, setPropertyId, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
