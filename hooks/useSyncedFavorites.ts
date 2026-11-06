import { useCallback, useEffect, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { trpc } from "@/lib/trpc";
import {
  normalizeFavoritePlaceKeys,
  planFavoriteSync,
  type FavoriteSyncSnapshot,
} from "@/shared/favoritePlaceKeys";

const FAVORITES_STORAGE_KEY = "maslay:favorites";
const FAVORITES_SNAPSHOT_KEY = "maslay:favorites-snapshot.v1";
const PENDING_REMOVALS_KEY = "maslay:favorites-pending-removals.v1";

type PendingFavoriteRemovals = { userId: number; keys: string[] };

type UseSyncedFavoritesResult = {
  favorites: string[];
  syncing: boolean;
  syncError: boolean;
  toggleFavorite: (key: string) => void;
};

const parseSnapshot = (value: string | null): FavoriteSyncSnapshot | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<FavoriteSyncSnapshot>;
    if (!Number.isSafeInteger(parsed.userId) || Number(parsed.userId) < 1) return null;
    return { userId: Number(parsed.userId), keys: normalizeFavoritePlaceKeys(parsed.keys) };
  } catch {
    return null;
  }
};

const parsePendingRemovals = (value: string | null): PendingFavoriteRemovals | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PendingFavoriteRemovals>;
    if (!Number.isSafeInteger(parsed.userId) || Number(parsed.userId) < 1) return null;
    const keys = normalizeFavoritePlaceKeys(parsed.keys);
    return keys.length ? { userId: Number(parsed.userId), keys } : null;
  } catch {
    return null;
  }
};

const areKeysEqual = (left: string[], right: string[]) =>
  left.length === right.length && left.every((key, index) => key === right[index]);

export function useSyncedFavorites(userId?: number): UseSyncedFavoritesResult {
  const [favorites, setFavorites] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<FavoriteSyncSnapshot | null>(null);
  const [pendingRemovals, setPendingRemovals] = useState<PendingFavoriteRemovals | null>(null);
  const [syncedUserId, setSyncedUserId] = useState<number | null>(null);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const lastSyncSignatureRef = useRef<string | null>(null);
  const previousUserIdRef = useRef<number | undefined>(userId);
  const directMutationInFlightRef = useRef(false);
  const retryRevisionRef = useRef(0);
  const [retryRevision, setRetryRevision] = useState(0);
  const utils = trpc.useUtils();

  const remoteFavorites = trpc.favorites.list.useQuery(undefined, {
    enabled: Boolean(userId) && storageLoaded,
    staleTime: 0,
    retry: 1,
    refetchOnWindowFocus: "always",
  });
  const mergeFavorites = trpc.favorites.merge.useMutation();
  const setFavorite = trpc.favorites.set.useMutation();

  useEffect(() => {
    if (previousUserIdRef.current === userId) return;
    previousUserIdRef.current = userId;
    lastSyncSignatureRef.current = null;
    void utils.favorites.list.reset(undefined);
  }, [userId, utils]);

  const applySyncedState = useCallback((keys: unknown, activeUserId: number) => {
    const normalized = normalizeFavoritePlaceKeys(keys);
    const nextSnapshot = { userId: activeUserId, keys: normalized };
    setFavorites((current) => areKeysEqual(current, normalized) ? current : normalized);
    setSnapshot((current) => current?.userId === activeUserId && areKeysEqual(current.keys, normalized) ? current : nextSnapshot);
    setSyncedUserId(activeUserId);
    setPendingRemovals((current) => current?.userId === activeUserId ? null : current);
    setSyncError(false);
    void AsyncStorage.multiSet([
      [FAVORITES_STORAGE_KEY, JSON.stringify(normalized)],
      [FAVORITES_SNAPSHOT_KEY, JSON.stringify(nextSnapshot)],
    ]).catch(() => setSyncError(true));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.multiGet([FAVORITES_STORAGE_KEY, FAVORITES_SNAPSHOT_KEY, PENDING_REMOVALS_KEY])
      .then((entries) => {
        if (cancelled) return;
        const favoriteValue = entries[0]?.[1];
        const snapshotValue = entries[1]?.[1];
        const pendingRemovalValue = entries[2]?.[1];
        if (favoriteValue) {
          try {
            setFavorites(normalizeFavoritePlaceKeys(JSON.parse(favoriteValue)));
          } catch {
            setFavorites([]);
          }
        }
        setSnapshot(parseSnapshot(snapshotValue ?? null));
        setPendingRemovals(parsePendingRemovals(pendingRemovalValue ?? null));
      })
      .catch(() => setSyncError(true))
      .finally(() => {
        if (!cancelled) setStorageLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!storageLoaded) return;
    void AsyncStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(normalizeFavoritePlaceKeys(favorites)))
      .catch(() => setSyncError(true));
  }, [favorites, storageLoaded]);

  useEffect(() => {
    if (!storageLoaded || !snapshot) return;
    void AsyncStorage.setItem(FAVORITES_SNAPSHOT_KEY, JSON.stringify(snapshot))
      .catch(() => setSyncError(true));
  }, [snapshot, storageLoaded]);

  useEffect(() => {
    if (!storageLoaded) return;
    const write = pendingRemovals
      ? AsyncStorage.setItem(PENDING_REMOVALS_KEY, JSON.stringify(pendingRemovals))
      : AsyncStorage.removeItem(PENDING_REMOVALS_KEY);
    void write.catch(() => setSyncError(true));
  }, [pendingRemovals, storageLoaded]);

  useEffect(() => {
    if (!userId || !storageLoaded || !remoteFavorites.data || remoteFavorites.isFetching || directMutationInFlightRef.current) return;
    const remoteKeys = normalizeFavoritePlaceKeys(remoteFavorites.data);
    const removals = pendingRemovals?.userId === userId ? pendingRemovals.keys : [];
    if (removals.length) {
      const signature = JSON.stringify({ userId, remoteKeys, removals });
      if (lastSyncSignatureRef.current === signature) return;
      lastSyncSignatureRef.current = signature;
      setSyncing(true);
      void (async () => {
        let keys = remoteKeys;
        for (const key of removals) {
          keys = normalizeFavoritePlaceKeys(await setFavorite.mutateAsync({ key, enabled: false }));
        }
        return keys;
      })()
        .then((keys) => {
          utils.favorites.list.setData(undefined, keys);
          applySyncedState(keys, userId);
        })
        .catch(() => {
          lastSyncSignatureRef.current = null;
          setSyncError(true);
        })
        .finally(() => setSyncing(false));
      return;
    }
    const plan = planFavoriteSync({ localKeys: favorites, remoteKeys, snapshot, userId });
    const signature = JSON.stringify({ userId, remoteKeys, localKeys: normalizeFavoritePlaceKeys(favorites), snapshot });
    if (lastSyncSignatureRef.current === signature) return;
    lastSyncSignatureRef.current = signature;

    if (plan.localAdditions.length === 0) {
      // Synchronize the local cache with the authoritative server query result.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      applySyncedState(remoteKeys, userId);
      return;
    }

    setSyncing(true);
    void mergeFavorites.mutateAsync({ keys: plan.localAdditions })
      .then((keys) => {
        const normalized = normalizeFavoritePlaceKeys(keys);
        utils.favorites.list.setData(undefined, normalized);
        applySyncedState(normalized, userId);
      })
      .catch(() => {
        lastSyncSignatureRef.current = null;
        setSyncError(true);
      })
      .finally(() => setSyncing(false));
  }, [applySyncedState, favorites, mergeFavorites, pendingRemovals, remoteFavorites.data, remoteFavorites.dataUpdatedAt, remoteFavorites.isFetching, setFavorite, snapshot, storageLoaded, userId, utils, retryRevision]);

  const toggleFavorite = useCallback((key: string) => {
    const normalizedKey = normalizeFavoritePlaceKeys([key])[0];
    if (!normalizedKey || syncing || !storageLoaded) return;
    const enabled = !favorites.includes(normalizedKey);
    const next = normalizeFavoritePlaceKeys(enabled
      ? [...favorites, normalizedKey]
      : favorites.filter((item) => item !== normalizedKey));

    if (!userId) {
      setFavorites(next);
      return;
    }

    if (!remoteFavorites.data) {
      setFavorites(next);
      if (enabled) {
        setPendingRemovals((current) => {
          if (current?.userId !== userId) return current;
          const keys = current.keys.filter((item) => item !== normalizedKey);
          return keys.length ? { userId, keys } : null;
        });
        setSnapshot((current) => current?.userId === userId
          ? { userId, keys: current.keys.filter((item) => item !== normalizedKey) }
          : current);
      } else {
        setPendingRemovals((current) => ({
          userId,
          keys: normalizeFavoritePlaceKeys([...(current?.userId === userId ? current.keys : []), normalizedKey]),
        }));
      }
      setSyncError(true);
      return;
    }

    directMutationInFlightRef.current = true;
    setSyncing(true);
    setFavorites(next);
    if (enabled) {
      setPendingRemovals((current) => {
        if (current?.userId !== userId) return current;
        const keys = current.keys.filter((item) => item !== normalizedKey);
        return keys.length ? { userId, keys } : null;
      });
      setSnapshot((current) => current?.userId === userId
        ? { userId, keys: current.keys.filter((item) => item !== normalizedKey) }
        : current);
    }
    void setFavorite.mutateAsync({ key: normalizedKey, enabled })
      .then((keys) => {
        const normalized = normalizeFavoritePlaceKeys(keys);
        utils.favorites.list.setData(undefined, normalized);
        applySyncedState(normalized, userId);
      })
      .catch(() => {
        if (!enabled) {
          setPendingRemovals((current) => ({
            userId,
            keys: normalizeFavoritePlaceKeys([
              ...(current?.userId === userId ? current.keys : []),
              normalizedKey,
            ]),
          }));
        }
        setSyncError(true);
        lastSyncSignatureRef.current = null;
        retryRevisionRef.current += 1;
        setRetryRevision(retryRevisionRef.current);
      })
      .finally(() => {
        directMutationInFlightRef.current = false;
        setSyncing(false);
      });
  }, [applySyncedState, favorites, remoteFavorites.data, setFavorite, storageLoaded, syncing, userId, utils]);

  const accountSyncPending = Boolean(userId && syncedUserId !== userId && !remoteFavorites.isError);
  return { favorites, syncing: syncing || !storageLoaded || accountSyncPending, syncError: syncError || Boolean(userId && remoteFavorites.isError), toggleFavorite };
}
