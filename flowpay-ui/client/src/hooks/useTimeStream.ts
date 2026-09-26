import { useCallback, useEffect, useRef, useState } from "react";
import {
  readEarnedAmount,
  readStream,
  readStreamCount,
  type StreamRecord,
} from "@/lib/timestream";
import type { Address } from "viem";

/** Poll cadence for the live counter, in ms. */
export const EARNED_POLL_MS = 1000;

export interface StreamSummary {
  id: bigint;
  record: StreamRecord;
  /** Withdrawable remainder, straight from earnedAmount(). */
  earned: bigint;
}

export interface StreamsResult {
  streams: StreamSummary[];
  total: bigint;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * The contract has no "list streams" getter, so ids are enumerated from
 * streamCount() and each row is read directly. Only the counterparty of a
 * stream is shown: a client sees the streams they funded, a freelancer the
 * streams they were hired for.
 */
export function useStreams(account: Address | undefined): StreamsResult {
  const [streams, setStreams] = useState<StreamSummary[]>([]);
  const [total, setTotal] = useState(0n);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!account) {
      setStreams([]);
      setTotal(0n);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const count = await readStreamCount();
        if (cancelled) return;
        setTotal(count);

        const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i));
        const rows = await Promise.all(
          ids.map(async (id) => {
            const [record, earned] = await Promise.all([
              readStream(id),
              readEarnedAmount(id),
            ]);
            return { id, record, earned };
          }),
        );
        if (cancelled) return;

        const lower = account.toLowerCase();
        const mine = rows.filter(
          ({ record }) =>
            record.client.toLowerCase() === lower ||
            record.freelancer.toLowerCase() === lower,
        );

        setStreams(mine);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not load streams.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account, nonce]);

  return { streams, total, loading, error, refresh };
}

export interface StreamDetail {
  record: StreamRecord | null;
  earned: bigint;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Reads the stream row and then keeps `earnedAmount` fresh every second so the
 * counter reflects the contract, never a locally interpolated guess. The
 * contract caps accrual at lastCheckIn + checkInInterval, which this polling
 * is what makes visible.
 */
export function useStreamDetail(streamId: bigint | null): StreamDetail {
  const [record, setRecord] = useState<StreamRecord | null>(null);
  const [earned, setEarned] = useState(0n);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const inFlight = useRef(false);

  useEffect(() => {
    if (streamId === null) {
      setRecord(null);
      setEarned(0n);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    readStream(streamId)
      .then((next) => {
        if (cancelled) return;
        setRecord(next);
        setEarned(0n);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Could not load the stream.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [streamId, nonce]);

  useEffect(() => {
    if (streamId === null) return;

    let cancelled = false;
    const tick = async () => {
      // Skip a tick rather than stacking requests behind a slow RPC.
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const value = await readEarnedAmount(streamId);
        if (!cancelled) setEarned(value);
      } catch {
        // A dropped poll is not worth an error banner; the next tick retries.
      } finally {
        inFlight.current = false;
      }
    };

    void tick();
    const timer = setInterval(tick, EARNED_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      inFlight.current = false;
    };
  }, [streamId, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { record, earned, loading, error, refresh };
}
