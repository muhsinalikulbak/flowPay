import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { Address, EIP1193Provider, Hash } from "viem";
import {
  acceptStream as acceptStreamTx,
  approveUsdc,
  checkIn as checkInTx,
  createStream as createStreamTx,
  describeError,
  readErc20Allowance,
  stopStream as stopStreamTx,
  TIMESTREAM_ADDRESS,
  txUrl,
  USDC_ADDRESS,
  waitForReceipt,
  withdraw as withdrawTx,
  type CreateStreamArgs,
  type TxStep,
} from "@/lib/timestream";

export interface TxProgress {
  step: TxStep | null;
  hash: Hash | null;
  pending: boolean;
}

const IDLE: TxProgress = { step: null, hash: null, pending: false };

const STEP_LABEL: Record<TxStep, string> = {
  approve: "USDC approval",
  createStream: "Stream creation",
  acceptStream: "Accepting the job",
  checkIn: "Check-in",
  withdraw: "Withdrawal",
  stopStream: "Stopping the stream",
};

type Sender = (provider: EIP1193Provider, account: Address) => Promise<Hash>;

/**
 * Wraps every write the app performs. Centralises pending/hash bookkeeping so
 * the views only render state, and always waits for a receipt before reporting
 * success - a submitted transaction is not a confirmed one.
 */
export function useTimeStreamActions(
  provider: EIP1193Provider | undefined,
  account: Address | undefined,
) {
  const [progress, setProgress] = useState<TxProgress>(IDLE);
  const [hashes, setHashes] = useState<Partial<Record<TxStep, Hash>>>({});

  const reportSuccess = useCallback((step: TxStep, hash: Hash, message: string) => {
    setHashes((prev) => ({ ...prev, [step]: hash }));
    setProgress(IDLE);
    toast.success(message, {
      description: "Confirmed on Monad Testnet",
      action: {
        label: "MonadScan",
        onClick: () => window.open(txUrl(hash), "_blank", "noopener"),
      },
    });
  }, []);

  const reportFailure = useCallback((step: TxStep, error: unknown) => {
    setProgress(IDLE);
    toast.error(`${STEP_LABEL[step]} failed`, { description: describeError(error) });
  }, []);

  const run = useCallback(
    async (step: TxStep, send: Sender, success: string): Promise<Hash | undefined> => {
      if (!provider || !account) {
        toast.error("Connect your wallet on Monad Testnet first.");
        return undefined;
      }
      try {
        setProgress({ step, hash: null, pending: true });
        const hash = await send(provider, account);
        setProgress({ step, hash, pending: true });
        const receipt = await waitForReceipt(hash);
        if (receipt.status !== "success") {
          throw new Error(`Transaction reverted: ${hash}`);
        }
        reportSuccess(step, hash, success);
        return hash;
      } catch (error) {
        reportFailure(step, error);
        return undefined;
      }
    },
    [provider, account, reportSuccess, reportFailure],
  );

  /**
   * createStream pulls `totalAmount` with transferFrom, so the client must
   * approve the contract first. The approval is skipped when the existing
   * allowance already covers the amount, which saves a transaction when
   * funding a second stream for the same freelancer.
   */
  const createStream = useCallback(
    async (args: CreateStreamArgs): Promise<Hash | undefined> => {
      if (!provider || !account) {
        toast.error("Connect your wallet on Monad Testnet first.");
        return undefined;
      }

      let approveHash: Hash | undefined;
      try {
        const allowance = await readErc20Allowance(USDC_ADDRESS, account, TIMESTREAM_ADDRESS);
        if (allowance < args.totalAmount) {
          setProgress({ step: "approve", hash: null, pending: true });
          approveHash = await approveUsdc(provider, account, args.totalAmount);
          setProgress({ step: "approve", hash: approveHash, pending: true });
          const approvalReceipt = await waitForReceipt(approveHash);
          if (approvalReceipt.status !== "success") {
            throw new Error(`USDC approval reverted: ${approveHash}`);
          }
          setHashes((prev) => ({ ...prev, approve: approveHash }));
        }
      } catch (error) {
        reportFailure("approve", error);
        return undefined;
      }

      try {
        setProgress({ step: "createStream", hash: null, pending: true });
        const hash = await createStreamTx(provider, account, args);
        setProgress({ step: "createStream", hash, pending: true });
        const receipt = await waitForReceipt(hash);
        if (receipt.status !== "success") {
          throw new Error(`Transaction reverted: ${hash}`);
        }
        reportSuccess("createStream", hash, "Stream created · waiting for the freelancer to accept");
        return hash;
      } catch (error) {
        reportFailure("createStream", error);
        return undefined;
      }
    },
    [provider, account, reportSuccess, reportFailure],
  );

  const acceptStream = useCallback(
    (streamId: bigint) =>
      run(
        "acceptStream",
        (p, a) => acceptStreamTx(p, a, streamId),
        "Job accepted · the clock is now running",
      ),
    [run],
  );

  const checkIn = useCallback(
    (streamId: bigint) =>
      run("checkIn", (p, a) => checkInTx(p, a, streamId), "Checked in · accrual un-capped"),
    [run],
  );

  const withdraw = useCallback(
    (streamId: bigint) =>
      run("withdraw", (p, a) => withdrawTx(p, a, streamId), "Withdrawal confirmed"),
    [run],
  );

  const stopStream = useCallback(
    (streamId: bigint) =>
      run(
        "stopStream",
        (p, a) => stopStreamTx(p, a, streamId),
        "Stream stopped · refund returned to the client",
      ),
    [run],
  );

  return { progress, hashes, createStream, acceptStream, checkIn, withdraw, stopStream };
}
