import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  Menu,
  Pause,
  Plus,
  ShieldCheck,
  UserRound,
  Zap,
  Wallet,
  WalletCards,
} from "lucide-react";
import { toast } from "sonner";
import type { Address, Hash } from "viem";
import {
  CHAIN_ID,
  TIMESTREAM_ADDRESS,
  USDC,
  USDC_ADDRESS,
  addressUrl,
  deployment,
  ensureMonadNetwork,
  fromTokenAmount,
  getInjectedProvider,
  toTokenAmount,
  txUrl,
  type StreamRecord,
} from "@/lib/timestream";
import {
  EARNED_POLL_MS,
  useStreamDetail,
  useStreams,
  type StreamSummary,
} from "@/hooks/useTimeStream";
import { useTimeStreamActions } from "@/hooks/useTimeStreamActions";

type Page = "dashboard" | "streams" | "create" | "detail";
type Role = "client" | "freelancer";

const shortAddress = (address: string) =>
  address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "";

const fmtAmount = (value: bigint, decimals = 2) =>
  Number(fromTokenAmount(value)).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

/**
 * earnedAmount() returns the withdrawable remainder, not the lifetime total, so
 * progress has to add back what was already withdrawn. Using earnedAmount()
 * alone would make the bar jump backwards after every payout.
 */
const lifetimeEarned = (record: StreamRecord, earned: bigint) =>
  record.withdrawn + earned;

const progressPercent = (record: StreamRecord, earned: bigint) => {
  if (record.totalAmount === 0n) return 0;
  const pct =
    Number((lifetimeEarned(record, earned) * 10000n) / record.totalAmount) / 100;
  return Math.min(100, Math.max(0, pct));
};

const formatDuration = (seconds: number) => {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d} day${d > 1 ? "s" : ""}`);
  if (h > 0) parts.push(`${h} hour${h > 1 ? "s" : ""}`);
  if (d === 0 && h === 0 && m > 0) parts.push(`${m} min`);
  return parts.length > 0 ? parts.join(" ") : `${seconds}s`;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Ticks on its own schedule so countdowns and the completed state stay live
 * without depending on some parent poll happening to resolve and re-render
 * them. Returns unix seconds.
 */
function useNowSeconds(intervalMs = 1000) {
  const [now, setNow] = useState(() => nowSeconds());
  useEffect(() => {
    const id = setInterval(() => setNow(nowSeconds()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** mm:ss / h:mm:ss / d h:mm. Tighter than formatDuration, which is for fixed spans. */
const formatCountdown = (seconds: number) => {
  if (seconds <= 0) return "Ended";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
};

/** Absolute wall-clock time in the viewer's locale. 0 means "not set yet". */
const formatTimestamp = (unixSeconds: bigint) => {
  const ms = Number(unixSeconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "Not set";
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** Deployment date, from the generated deployment record rather than a hardcoded string. */
const formatDeployedAt = () => {
  const ms = Date.parse(deployment.deployedAt);
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" }) : "unknown";
};

type StreamStatus = "awaiting" | "streaming" | "completed" | "stopped";

/**
 * A stream that is still `active` but past its endTime has finished paying out
 * on its own - earnedAmount() is capped at endTime, so nothing more can accrue.
 * That is genuinely different from "stopped", which means the client ended the
 * stream early and the unearned remainder came back to them.
 */
const statusOf = (record: StreamRecord, now: number): StreamStatus => {
  if (!record.active) return "stopped";
  if (!record.accepted) return "awaiting";
  return now >= Number(record.endTime) ? "completed" : "streaming";
};

const STATUS_COPY: Record<StreamStatus, { label: string; className: string }> =
  {
    streaming: { label: "Streaming", className: "bg-[#e9f8f2] text-[#24845f]" },
    completed: { label: "Completed", className: "bg-[#e8eef7] text-[#243B5C]" },
    awaiting: {
      label: "Awaiting acceptance",
      className: "bg-[#fff4e6] text-[#b06d1f]",
    },
    stopped: { label: "Stopped", className: "bg-[#eef0f4] text-[#667085]" },
  };

/** Human label for a stream. The contract stores no title, so none is invented. */
const streamTitle = (id: bigint, record: StreamRecord, viewer: Address) =>
  record.client.toLowerCase() === viewer.toLowerCase()
    ? `Payment to ${shortAddress(record.freelancer)}`
    : `Payment from ${shortAddress(record.client)}`;

function Logo() {
  return <div className="flex items-center gap-2.5"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[#243B5C] shadow-[0_6px_18px_rgba(36,59,92,.22)]"><div className="relative h-4.5 w-4.5 rounded-full border-[2.5px] border-white"><span className="absolute -bottom-1 -right-1 h-2 w-2 rounded-full bg-white" /></div></div><span className="font-display text-[18px] font-bold tracking-[-.045em] text-[#101828]">FlowPay</span></div>;
}

function WalletPill({ address, onClick }: { address: string; onClick: () => void }) {
  return <button onClick={onClick} className="flex items-center gap-2.5 rounded-xl border border-[#dfe3ec] bg-white px-3.5 py-2.5 text-[12px] font-semibold text-[#26324a] shadow-[0_2px_6px_rgba(16,24,40,.03)] transition hover:border-[#B7C5D8] hover:shadow-[0_4px_12px_rgba(36,59,92,.1)] active:scale-[.98]"><span className="h-2 w-2 rounded-full bg-[#38a97d]" />{shortAddress(address)}<ChevronDown className="h-3.5 w-3.5 text-[#8b94a8]" /></button>;
}

function NetworkBadge() {
  return <span className="inline-flex items-center gap-2 rounded-lg border border-[#D9E1EA] bg-[#F2F5F9] px-2.5 py-1.5 text-[10px] font-semibold text-[#243B5C]"><span className="grid h-4 w-4 place-items-center rounded bg-[#243B5C] text-[8px] font-bold text-white">M</span> Monad Testnet</span>;
}

function AppHeader({ address, page, role, setPage, onDisconnect }: { address: string; page: Page; role: Role; setPage: (page: Page) => void; onDisconnect: () => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = (next: Page) => { setPage(next); setMobileOpen(false); };
  return <header className="sticky top-0 z-20 border-b border-[#eaecf2] bg-white/90 px-5 backdrop-blur-xl sm:px-8 lg:px-12"><div className="flex h-[72px] items-center justify-between"><div className="flex items-center gap-4 lg:gap-9"><button aria-label="Toggle navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(!mobileOpen)} className="rounded-lg p-2 text-[#667085] hover:bg-[#f2f4f7] lg:hidden"><Menu className="h-5 w-5" /></button><Logo /><nav className="hidden items-center gap-1 lg:flex"><button onClick={() => navigate("dashboard")} className={`header-link ${page === "dashboard" || page === "detail" ? "active" : ""}`}>Dashboard</button><button onClick={() => navigate("streams")} className={`header-link ${page === "streams" ? "active" : ""}`}>My Streams</button>{role === "client" && page !== "detail" && <button onClick={() => navigate("create")} className={`header-link ${page === "create" ? "active" : ""}`}>Create Stream</button>}</nav></div><div className="flex items-center gap-2.5"><NetworkBadge /><WalletPill address={address} onClick={onDisconnect} /></div></div>{mobileOpen && <nav className="grid gap-1 border-t border-[#eaecf2] py-3 lg:hidden"><button onClick={() => navigate("dashboard")} className="header-link text-left">Dashboard</button><button onClick={() => navigate("streams")} className="header-link text-left">My Streams</button>{role === "client" && page !== "detail" && <button onClick={() => navigate("create")} className="header-link text-left">Create Stream</button>}</nav>}</header>;
}

function Landing({ onConnect, role, setRole, walletStep, onBack }: { onConnect: () => void; role: Role | null; setRole: (role: Role) => void; walletStep: boolean; onBack: () => void }) {
  return <main className="relative grid min-h-screen place-items-center overflow-hidden bg-[radial-gradient(ellipse_at_50%_0%,#EEF2F7_0%,#fbfcfe_52%)] px-5 py-12"><div className="pointer-events-none absolute -left-36 top-1/3 h-72 w-72 rounded-full bg-[#E9EEF5]/70 blur-3xl"/><div className="pointer-events-none absolute -right-32 bottom-0 h-80 w-80 rounded-full bg-[#e9f2ff]/70 blur-3xl"/><div className="relative w-full max-w-[760px] text-center"><div className="mx-auto mb-5 flex w-fit items-center gap-2.5"><div className="grid h-10 w-10 place-items-center rounded-[14px] bg-[#243B5C] shadow-[0_8px_24px_rgba(36,59,92,.22)]"><div className="relative h-4.5 w-4.5 rounded-full border-[2.5px] border-white"><span className="absolute -bottom-1 -right-1 h-2 w-2 rounded-full bg-white"/></div></div><span className="font-display text-[22px] font-bold tracking-[-.05em] text-[#101828]">FlowPay</span></div><p className="text-[12px] font-semibold tracking-wide text-[#243B5C]">Payments that flow with time.</p>{!walletStep ? <><h1 className="mx-auto mt-4 max-w-[560px] font-display text-[35px] font-bold leading-[1.12] tracking-[-.065em] text-[#101828] sm:text-[46px]">Freelance payments, made fair and effortless.</h1><p className="mx-auto mt-4 max-w-[480px] text-[14px] leading-6 text-[#667085]">Stream freelance payments securely and transparently with smart contracts.</p><div className="mt-10 grid gap-4 text-left sm:grid-cols-2">{([{ id: "client" as const, title: "I'm a Client", desc: "Hire freelancers and stream payments automatically as work progresses.", note: "Create and manage payment streams", icon: BriefcaseBusiness }, { id: "freelancer" as const, title: "I'm a Freelancer", desc: "Get paid continuously and withdraw your earned balance whenever you want.", note: "Track and withdraw your earnings", icon: UserRound }]).map((item) => <button key={item.id} onClick={() => setRole(item.id)} className={`group rounded-[20px] border bg-white/90 p-6 shadow-[0_12px_35px_rgba(16,24,40,.055)] transition hover:-translate-y-1 hover:border-[#B4C2D5] hover:shadow-[0_18px_42px_rgba(36,59,92,.12)] ${role === item.id ? "border-[#7188A8] ring-4 ring-[#243B5C]/[.08]" : "border-[#e7e9f0]"}`}><span className="grid h-11 w-11 place-items-center rounded-[14px] bg-[#EEF2F7] text-[#243B5C]"><item.icon className="h-5 w-5"/></span><span className="mt-5 block font-display text-[18px] font-bold tracking-[-.04em] text-[#101828]">{item.title}</span><span className="mt-2 block min-h-[44px] text-[12px] leading-5 text-[#667085]">{item.desc}</span><span className="mt-5 flex items-center justify-between border-t border-[#eef0f4] pt-4 text-[10px] font-semibold text-[#98a2b3]"><span>{item.note}</span><span className="flex items-center gap-1.5 text-[11px] font-bold text-[#243B5C]">Continue <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5"/></span></span></button>)}</div><div className="mt-7 flex items-center justify-center gap-2 text-[10px] font-semibold text-[#8b91a3]"><ShieldCheck className="h-4 w-4 text-[#243B5C]"/> Secured by smart contracts <span className="text-[#c7cad4]">·</span> Monad Testnet</div>
<div className="mt-3 flex items-center justify-center text-[10px] text-[#98a2b3]">Escrow and accrual handled by <ContractRef className="text-[10px] text-[#98a2b3]" /></div></> : <div className="mx-auto mt-8 max-w-[460px] text-left"><button onClick={onBack} className="mb-5 flex items-center gap-1.5 text-[11px] font-semibold text-[#667085] hover:text-[#243B5C]"><ArrowLeft className="h-3.5 w-3.5"/> Change role</button><div className="rounded-[22px] border border-[#e4e6ee] bg-white p-6 shadow-[0_22px_60px_rgba(16,24,40,.1)] sm:p-8"><span className="eyebrow">{role === "client" ? "Client account" : "Freelancer account"}</span><h1 className="mt-2 font-display text-[29px] font-bold tracking-[-.06em] text-[#101828]">Connect your wallet</h1><p className="mt-2 text-[12px] leading-5 text-[#667085]">{role === "client" ? "Connect your wallet to create and manage payment streams." : "Connect your wallet to view your payment streams and earnings."}</p><div className="mt-7 flex items-center gap-3 rounded-xl border border-[#eaecf2] bg-[#fafbfc] p-4"><div className="grid h-11 w-11 place-items-center rounded-xl bg-[#fff2e5] text-[22px] font-bold text-[#d98c32]">⬡</div><div className="flex-1"><div className="text-[12px] font-bold text-[#344054]">Browser wallet</div><div className="mt-1 text-[10px] text-[#98a2b3]">MetaMask or any EIP-1193 wallet</div></div><span className="h-2 w-2 rounded-full bg-[#d0d5dd]"/></div><button onClick={onConnect} className="primary mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[12px] font-bold"><Wallet className="h-4 w-4"/> Connect Wallet <ArrowRight className="h-4 w-4"/></button><div className="mt-5 flex items-center justify-center gap-2 border-t border-[#eef0f4] pt-5 text-[10px] font-semibold text-[#667085]"><ShieldCheck className="h-4 w-4 text-[#243B5C]"/> Monad Testnet <span className="text-[#d0d5dd]">·</span> Chain ID {CHAIN_ID}</div></div><p className="mt-4 text-center text-[10px] text-[#98a2b3]">Your wallet is your secure sign-in. No email or password needed.</p></div>}</div></main>;
}

function Stat({ label, value, note, icon }: { label: string; value: string; note: string; icon: React.ReactNode }) {
  return <div className="soft-card rounded-2xl border border-[#e7e9f0] bg-white p-5"><div className="flex items-start justify-between"><span className="text-[12px] font-medium text-[#667085]">{label}</span><span className="grid h-8 w-8 place-items-center rounded-lg bg-[#EEF2F7] text-[#243B5C]">{icon}</span></div><div className="mt-5 font-display text-[26px] font-bold tracking-[-.05em] text-[#101828]">{value}</div><div className="mt-1.5 text-[11px] text-[#98a2b3]">{note}</div></div>;
}

function SummaryRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return <div className="flex items-center justify-between text-[11px]"><span className="text-[#8b91a3]">{label}</span><span className={`${mono ? "font-mono" : "font-semibold"} text-[#344054]`}>{value}</span></div>;
}

/**
 * The app is branded FlowPay; the contract it actually talks to is TimeStream.
 * Printing the name next to the address ties the two together, and both are
 * linked so the address can be verified on the explorer without hunting for it.
 */
function ContractRef({ className }: { className?: string }) {
  return <a href={addressUrl(TIMESTREAM_ADDRESS)} target="_blank" rel="noreferrer" title={`${deployment.contractName} · ${TIMESTREAM_ADDRESS}`} className={`inline-flex items-center gap-1.5 underline underline-offset-4 ${className ?? "text-[10px] text-[#243B5C]"}`}>
<span className="font-semibold">{deployment.contractName}</span>
<span className="font-mono">{shortAddress(TIMESTREAM_ADDRESS)}</span>
<ExternalLink className="h-3 w-3 shrink-0"/>
</a>;
}

function StreamCard({ item, viewer, onOpen, now }: { item: StreamSummary; viewer: Address; onOpen: (item: StreamSummary) => void; now: number }) {
  const { id, record, earned } = item;
  const status = statusOf(record, now);
  const isClient = record.client.toLowerCase() === viewer.toLowerCase();
  const percent = progressPercent(record, earned);
  const total = fmtAmount(record.totalAmount);
  return <div className="soft-card rounded-2xl border border-[#e7e9f0] bg-white p-5 transition hover:-translate-y-0.5 hover:border-[#B4C3D7] hover:shadow-[0_14px_32px_rgba(16,24,40,.07)]"><div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="font-display text-[15px] font-bold text-[#101828]">{streamTitle(id, record, viewer)}</h3><span className={`rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-[.1em] ${STATUS_COPY[status].className}`}>{STATUS_COPY[status].label}</span></div><div className="mt-2 text-[11px] text-[#98a2b3]">{isClient ? "Freelancer" : "Client"} <span className="font-mono text-[#667085]">{shortAddress(isClient ? record.freelancer : record.client)}</span></div></div><span className="font-mono text-[10px] text-[#98a2b3]">#{id.toString()}</span></div><div className="mt-6 grid grid-cols-3 gap-3"><div><div className="label">Total</div><div className="value">{total} <small>{USDC.symbol}</small></div></div><div><div className="label">Earned</div><div className="value text-[#24845f]">{fmtAmount(lifetimeEarned(record, earned))} <small>{USDC.symbol}</small></div></div><div><div className="label">Remaining</div><div className="value">{fmtAmount(record.totalAmount - lifetimeEarned(record, earned))} <small>{USDC.symbol}</small></div></div></div><div className="mt-5 h-2 overflow-hidden rounded-full bg-[#edf0f5]"><div className="h-full rounded-full bg-[#243B5C]" style={{ width: `${percent}%` }} /></div><div className="mt-2 flex justify-between text-[10px] text-[#98a2b3]"><span>{percent}% streamed</span><span className="flex items-center gap-1"><Clock3 className="h-3 w-3" /> {!record.accepted ? "clock not started" : status === "completed" ? "fully streamed" : `${formatCountdown(Number(record.endTime) - now)} left`}</span></div><button onClick={() => onOpen(item)} className="mt-5 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[#dfe3ec] text-[11px] font-bold text-[#475467] transition hover:border-[#B7C5D8] hover:bg-[#F5F7FA] hover:text-[#243B5C]">View Stream <ArrowRight className="h-3.5 w-3.5" /></button></div>;
}

function Dashboard({ streams, total, loading, error, viewer, role, page, onCreate, onOpen, onViewAll, onRetry }: { streams: StreamSummary[]; total: bigint; loading: boolean; error: string | null; viewer: Address; role: Role; page: Page; onCreate: () => void; onOpen: (item: StreamSummary) => void; onViewAll: () => void; onRetry: () => void }) {
  const isFreelancer = role === "freelancer";
  const now = useNowSeconds();
  const mine = streams.filter((s) => {
    const isClient = s.record.client.toLowerCase() === viewer.toLowerCase();
    return isClient ? !isFreelancer : isFreelancer;
  });
  const active = mine.filter((s) => s.record.active);
  const funded = mine.reduce((sum, s) => sum + s.record.totalAmount, 0n);
  const streamed = mine.reduce((sum, s) => sum + lifetimeEarned(s.record, s.earned), 0n);
  const withdrawn = mine.reduce((sum, s) => sum + s.record.withdrawn, 0n);
  const available = mine.reduce((sum, s) => sum + s.earned, 0n);
  const heading = page === "streams" ? (isFreelancer ? "My Payments" : "My Streams") : isFreelancer ? "Your Earnings" : "Dashboard";

  if (error) return <main className="mx-auto w-full max-w-[1280px] px-5 py-9 sm:px-8 lg:px-12"><div className="mx-auto grid max-w-[560px] place-items-center rounded-2xl border border-[#f0d5d5] bg-white py-16 text-center"><div className="grid h-14 w-14 place-items-center rounded-2xl bg-[#fdf0f0] text-[#c0392b]"><CircleHelp className="h-6 w-6" /></div><h1 className="mt-5 font-display text-[22px] font-bold tracking-[-.05em] text-[#101828]">Could not read the contract</h1><p className="mt-2 text-[12px] leading-5 text-[#667085]">{error}</p><button onClick={onRetry} className="primary mt-6 h-11 rounded-xl px-5 text-[12px] font-bold">Try again</button></div></main>;

  return <main className="mx-auto w-full max-w-[1280px] px-5 py-9 sm:px-8 lg:px-12">{mine.length === 0 && !loading ? <div className="mx-auto grid max-w-[650px] place-items-center py-20 text-center"><div className="grid h-16 w-16 place-items-center rounded-2xl bg-[#EEF2F7] text-[#243B5C]"><Link2 className="h-7 w-7" /></div><h1 className="mt-6 font-display text-[28px] font-bold tracking-[-.05em] text-[#101828]">{isFreelancer ? "No active payments" : "No active payment streams"}</h1><p className="mt-3 text-[14px] text-[#667085]">{isFreelancer ? "When a client creates a stream for you, your earnings will appear here." : "Create your first payment stream and let payments flow automatically."}</p>{!isFreelancer && <button onClick={onCreate} className="mt-7 flex h-11 items-center gap-2 rounded-xl bg-[#243B5C] px-5 text-[12px] font-bold text-white transition hover:bg-[#192B45]"><Plus className="h-4 w-4" /> Create New Stream</button>}<p className="mt-6 text-[10px] text-[#98a2b3]">{total.toString()} stream{total === 1n ? "" : "s"} exist on-chain · none involve this wallet</p></div> : <><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="eyebrow">{page === "streams" ? "On-chain activity" : "Live on Monad Testnet"}</p><h1 className="page-title">{heading}</h1><p className="page-subtitle">{isFreelancer ? "Track your active payment streams and earnings." : "Manage your freelance payments."}</p></div>{!isFreelancer && <button onClick={onCreate} className="primary inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[12px] font-bold"><Plus className="h-4 w-4" /> Create New Stream</button>}</div>{page !== "streams" && <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{isFreelancer ? <><Stat label="Active Payments" value={active.length.toString()} note="Currently streaming" icon={<Zap className="h-4 w-4" />} /><Stat label="Earned" value={`${fmtAmount(streamed)} ${USDC.symbol}`} note="Across your streams" icon={<ArrowUpRight className="h-4 w-4" />} /><Stat label="Available to Withdraw" value={`${fmtAmount(available)} ${USDC.symbol}`} note="Earned, not withdrawn" icon={<WalletCards className="h-4 w-4" />} /><Stat label="Total Received" value={`${fmtAmount(withdrawn)} ${USDC.symbol}`} note="All time" icon={<Check className="h-4 w-4" />} /></> : <><Stat label="Active Streams" value={active.length.toString()} note="Currently streaming" icon={<Zap className="h-4 w-4" />} /><Stat label="Total Funded" value={`${fmtAmount(funded)} ${USDC.symbol}`} note="Escrowed in the contract" icon={<ArrowUpRight className="h-4 w-4" />} /><Stat label="Streamed" value={`${fmtAmount(streamed)} ${USDC.symbol}`} note="Earned by freelancers" icon={<WalletCards className="h-4 w-4" />} /><Stat label="Remaining" value={`${fmtAmount(funded - streamed)} ${USDC.symbol}`} note="Still locked in streams" icon={<Check className="h-4 w-4" />} /></>}</div>}<div className="mt-10 flex items-center justify-between"><div><h2 className="section-title">{isFreelancer ? "Active Payments" : "Active Streams"}</h2><p className="section-note">Read directly from the contract.</p></div>{page !== "streams" && <button onClick={onViewAll} className="text-[11px] font-bold text-[#243B5C]">View all streams <ArrowRight className="ml-1 inline h-3 w-3" /></button>}</div>{loading && mine.length === 0 ? <div className="mt-4 grid gap-4 lg:grid-cols-2"><div className="soft-card h-[188px] animate-pulse rounded-2xl border border-[#e7e9f0] bg-white"/><div className="soft-card h-[188px] animate-pulse rounded-2xl border border-[#e7e9f0] bg-white"/></div> : <div className="mt-4 grid gap-4 lg:grid-cols-2">{mine.map((item) => <StreamCard key={item.id.toString()} item={item} viewer={viewer} onOpen={onOpen} now={now}/>)}</div>}</>}</main>;
}

function CreateStream({ onBack, onSubmit, pendingStep, pendingHash }: { onBack: () => void; onSubmit: (input: { freelancer: Address; amount: bigint; durationSeconds: bigint }) => void; pendingStep: string | null; pendingHash: Hash | null }) {
  const [amount, setAmount] = useState("1000");
  const [duration, setDuration] = useState("7");
  const [unit, setUnit] = useState("Days");
  const [freelancer, setFreelancer] = useState("");
  const [agreed, setAgreed] = useState(false);

  const hours = Number(duration) * (unit === "Weeks" ? 168 : unit === "Days" ? 24 : 1);
  const amountNumber = Number(amount);
  const rateable = Number.isFinite(amountNumber) && amountNumber > 0 && Number.isFinite(hours) && hours > 0;
  const rate = useMemo(() => (rateable ? ((amountNumber * 24) / hours).toFixed(2) : "—"), [rateable, amountNumber, hours]);
  const perHour = useMemo(() => (rateable ? (amountNumber / hours).toFixed(2) : "—"), [rateable, amountNumber, hours]);
  // 168 hours in a week, so the weekly rate is the hourly rate scaled up.
  const perWeek = useMemo(() => (rateable ? ((amountNumber / hours) * 168).toFixed(2) : "—"), [rateable, amountNumber, hours]);
  const validAddress = /^0x[a-fA-F0-9]{40}$/.test(freelancer);
  const busy = pendingStep !== null;

  const submit = () => {
    if (!validAddress) { toast.error("Enter a valid freelancer wallet address."); return; }
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) { toast.error("Enter an amount greater than zero."); return; }
    if (!Number.isFinite(hours) || hours <= 0) { toast.error("Enter a valid stream duration."); return; }
    onSubmit({
      freelancer: freelancer as Address,
      amount: toTokenAmount(amountNumber.toString()),
      durationSeconds: BigInt(Math.round(hours * 3600)),
    });
  };

  return <main className="mx-auto w-full max-w-[1100px] px-5 py-9 sm:px-8 lg:px-12"><button onClick={onBack} disabled={busy} className="mb-7 flex items-center gap-2 text-[11px] font-semibold text-[#667085] hover:text-[#243B5C] disabled:opacity-40"><ArrowLeft className="h-3.5 w-3.5"/> Back to Dashboard</button><p className="eyebrow">New agreement · {USDC.symbol} on Monad Testnet</p><h1 className="page-title">Create New Stream</h1><p className="page-subtitle">The full amount is escrowed when the stream is created, then released linearly as time passes.</p><div className="mt-8 grid gap-5 lg:grid-cols-[1fr_370px]"><div className="soft-card rounded-2xl border border-[#e7e9f0] bg-white p-6 sm:p-8"><div className="space-y-6"><label className="block"><span className="field-label">Freelancer Wallet Address</span><div className="relative"><input placeholder="0x followed by 40 characters" value={freelancer} onChange={(e) => setFreelancer(e.target.value.trim())} className="field-input w-full pr-10 font-mono"/><button type="button" aria-label="Copy freelancer wallet address" disabled={!freelancer} onClick={() => { navigator.clipboard.writeText(freelancer).then(() => toast.success("Wallet address copied")).catch(() => toast.error("Could not copy wallet address")); }} className="absolute right-3 top-1/2 -translate-y-1/2 disabled:opacity-40"><Copy className="h-4 w-4 text-[#98a2b3]"/></button></div></label><div><span className="field-label">Total Amount</span><div className="flex gap-2"><input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0" step="any" className="field-input flex-1"/><div className="field-input flex w-[190px] items-center gap-2"><span className="h-4 w-4 rounded-full bg-[#2775CA]"/><span className="text-[12px] font-semibold">{USDC.symbol}</span></div></div><p className="mt-2 text-[10px] text-[#98a2b3]">Token contract: <span className="font-mono">{shortAddress(USDC_ADDRESS)}</span> · {USDC.decimals} decimals</p></div><div><span className="field-label">Duration</span><div className="flex gap-2"><input value={duration} onChange={(e) => setDuration(e.target.value)} type="number" min="0" step="any" className="field-input flex-1"/><select value={unit} onChange={(e) => setUnit(e.target.value)} className="field-input w-[126px]"><option>Hours</option><option>Days</option><option>Weeks</option></select></div>
<p className="mt-2 text-[10px] text-[#98a2b3]">The freelancer earns this much for every unit of time the stream runs. Nothing is released before they accept.</p>
</div>
<div className="rounded-xl border border-[#e7e9f0] bg-[#fafbfc] p-4">
<div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-[.12em] text-[#8b91a3]"><span>Streaming rate</span><span className={rateable ? "text-[#24845f]" : "text-[#98a2b3]"}>{rateable ? "live preview" : "enter amount + duration"}</span></div>
<div className="mt-3 font-display text-[26px] font-bold tracking-[-.045em] text-[#243B5C]">{rate} <span className="text-[11px] font-medium text-[#8b91a3]">{USDC.symbol} / day</span></div>
<div className="mt-3 grid grid-cols-2 gap-3 border-t border-[#eef0f4] pt-3 text-[10px] text-[#8b91a3]"><div>Per hour <span className="font-semibold text-[#344054]">{perHour}</span></div><div>Per week <span className="font-semibold text-[#344054]">{perWeek}</span></div></div>
</div><label className="flex items-start gap-3 rounded-xl border border-[#eaecf2] bg-[#fafbfc] p-3.5"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#243B5C]"/><span className="text-[11px] leading-5 text-[#667085]">I have reviewed the freelancer address and payment amount.</span></label><button onClick={submit} disabled={!agreed || busy} className="primary h-12 w-full rounded-xl text-[13px] font-bold disabled:cursor-not-allowed disabled:opacity-40">{busy ? <><Loader2 className="mr-2 inline h-4 w-4 animate-spin"/>{pendingStep === "approve" ? "Approving USDC…" : "Creating stream…"}</> : <>Approve &amp; create stream <ArrowRight className="ml-2 inline h-4 w-4"/></>}</button>{pendingHash && <a href={txUrl(pendingHash)} target="_blank" rel="noreferrer" className="block text-center text-[10px] font-bold text-[#243B5C] underline underline-offset-4">View submitted transaction on MonadScan</a>}</div></div><div className="h-fit rounded-2xl border border-[#DDE5EF] bg-[#F5F7FA] p-6 lg:sticky lg:top-24"><div className="flex items-center justify-between"><span className="text-[12px] font-bold text-[#475467]">Agreement Summary</span><span className="rounded-full bg-white px-2 py-1 text-[9px] font-bold uppercase tracking-[.12em] text-[#243B5C]">On-chain</span></div><div className="mt-7 space-y-4"><SummaryRow label="Freelancer" value={freelancer || "Not set"} mono/><SummaryRow label="Total" value={`${amount || "0"} ${USDC.symbol}`}/><SummaryRow label="Duration" value={`${duration || "0"} ${unit.toLowerCase()}`}/><div className="border-t border-[#E5EBF2] pt-4"><div className="text-[10px] text-[#8b91a3]">Streaming rate</div><div className="mt-1 font-display text-[22px] font-bold tracking-[-.04em] text-[#243B5C]">{rate} <span className="text-[11px] font-medium text-[#8b91a3]">{USDC.symbol} / day</span></div></div></div><div className="mt-7 flex items-start gap-2 text-[10px] leading-5 text-[#8b91a3]"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#243B5C]"/> Two transactions: a {USDC.symbol} approval, then the stream creation that escrows the funds.</div><div className="mt-3"><ContractRef className="text-[10px] font-bold text-[#243B5C]" /></div></div></div></main>;
}

function TxPanel({ step, hash, hashes }: { step: string | null; hash: Hash | null; hashes: Partial<Record<string, Hash>> }) {
  if (step === null && hash === null) return null;
  return <div className="rounded-2xl border border-[#D1DBE8] bg-[#faf9ff] p-5"><div className="flex items-center gap-2 text-[11px] font-bold text-[#243B5C]">{step !== null ? <><Loader2 className="h-3.5 w-3.5 animate-spin"/> {step === "approve" ? "Approving USDC…" : "Sending transaction…"}</> : <><Check className="h-3.5 w-3.5 text-[#38a97d]"/> Transaction confirmed</>}</div>{Object.entries(hashes).filter(([, v]) => v).map(([k, v]) => <a key={k} href={txUrl(v as Hash)} target="_blank" rel="noreferrer" className="mt-2 flex items-center justify-between text-[10px] text-[#667085]"><span className="capitalize">{k}</span><span className="font-mono">{shortAddress(v as string)} <ExternalLink className="inline h-3 w-3" /></span></a>)}</div>;
}

function Detail({ item, viewer, earned, loading, error, onBack, onRefresh, actions, busyStep }: { item: StreamSummary; viewer: Address; earned: bigint; loading: boolean; error: string | null; onBack: () => void; onRefresh: () => void; actions: { accept: () => void; withdraw: () => void; stop: () => void }; busyStep: string | null }) {
  const record = item.record;
  const isClient = record.client.toLowerCase() === viewer.toLowerCase();
  const isFreelancer = record.freelancer.toLowerCase() === viewer.toLowerCase();
  const busy = busyStep !== null;
  const now = useNowSeconds();
  const status = statusOf(record, now);

  const confirmStop = () => {
    const earnedNow = fmtAmount(lifetimeEarned(record, earned));
    const refund = fmtAmount(record.totalAmount - lifetimeEarned(record, earned));
    if (!window.confirm(`Stop this stream? The freelancer keeps ${earnedNow} ${USDC.symbol} and ${refund} ${USDC.symbol} is returned to you. This cannot be undone.`)) return;
    actions.stop();
  };

  if (error) return <main className="mx-auto w-full max-w-[1100px] px-5 py-9 sm:px-8 lg:px-12"><button onClick={onBack} className="mb-7 flex items-center gap-2 text-[11px] font-semibold text-[#667085] hover:text-[#243B5C]"><ArrowLeft className="h-3.5 w-3.5"/> Back to Streams</button><div className="rounded-2xl border border-[#f0d5d5] bg-white p-6 text-[12px] text-[#667085]">{error}</div></main>;

  return <main className="mx-auto w-full max-w-[1100px] px-5 py-9 sm:px-8 lg:px-12"><button onClick={onBack} className="mb-7 flex items-center gap-2 text-[11px] font-semibold text-[#667085] hover:text-[#243B5C]"><ArrowLeft className="h-3.5 w-3.5"/> Back to Streams</button><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><div className="flex items-center gap-2"><p className="eyebrow">Stream #{item.id.toString()} · Monad Testnet</p><span className={`rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-[.12em] ${STATUS_COPY[status].className}`}>{STATUS_COPY[status].label}</span></div><h1 className="page-title">{streamTitle(item.id, record, viewer)}</h1></div><span className="rounded-lg border border-[#dfe3ec] bg-white px-3 py-2 text-[10px] font-bold text-[#475467]">{isClient ? "You are the client" : isFreelancer ? "You are the freelancer" : "Observer"}</span></div><div className="mt-8 grid gap-5 lg:grid-cols-[1fr_330px]"><div className="soft-card rounded-2xl border border-[#e7e9f0] bg-white p-6 sm:p-8"><div className="flex items-center justify-between"><span className="label uppercase tracking-[.12em]">Earned so far · live</span><span className="flex items-center gap-1.5 text-[10px] font-bold text-[#24845f]"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#38a97d]"/> polling {EARNED_POLL_MS / 1000}s</span></div><div className="mt-6 flex items-baseline gap-2"><span className="font-display text-[56px] font-bold tracking-[-.08em] text-[#101828]">{loading ? "—" : fmtAmount(lifetimeEarned(record, earned))}</span><span className="text-[14px] font-semibold text-[#98a2b3]">{USDC.symbol}</span></div><div className="mt-2 text-[12px] text-[#667085]">{fmtAmount(record.totalAmount)} {USDC.symbol} total · {fmtAmount(earned)} {USDC.symbol} withdrawable now</div><div className="mt-8 h-3 overflow-hidden rounded-full bg-[#edf0f5]"><div className="h-full rounded-full bg-[#243B5C]" style={{ width: `${progressPercent(record, earned)}%` }}/></div><div className="mt-2 flex justify-between text-[10px] text-[#98a2b3]"><span>0%</span><span>{progressPercent(record, earned)}%</span><span>100%</span></div><div className="mt-8 grid gap-3 sm:grid-cols-3"><div className="metric"><span>Earned</span><strong>{fmtAmount(lifetimeEarned(record, earned))} {USDC.symbol}</strong></div><div className="metric"><span>Remaining</span><strong>{fmtAmount(record.totalAmount - lifetimeEarned(record, earned))} {USDC.symbol}</strong></div><div className="metric"><span>{record.accepted && status !== "completed" ? "Time remaining" : "Status"}</span><strong>{!record.accepted ? "Not accepted yet" : status === "completed" ? "Fully streamed" : formatCountdown(Number(record.endTime) - now)}</strong></div></div><div className="mt-5 grid gap-3 border-t border-[#eef0f4] pt-5 text-[11px] sm:grid-cols-2"><SummaryRow label="Client" value={record.client} mono/><SummaryRow label="Freelancer" value={record.freelancer} mono/><SummaryRow label="Withdrawn" value={`${fmtAmount(record.withdrawn)} ${USDC.symbol}`}/><SummaryRow label="Duration" value={formatDuration(Number(record.durationSeconds))}/><SummaryRow label="Started" value={formatTimestamp(record.startTime)}/><SummaryRow label="Ends" value={formatTimestamp(record.endTime)}/></div><button onClick={onRefresh} className="mt-5 text-[10px] font-bold text-[#243B5C] underline underline-offset-4">Refresh from contract</button></div><div className="space-y-4"><div className="soft-card rounded-2xl border border-[#e7e9f0] bg-white p-6"><div className="text-[12px] font-bold text-[#344054]">Actions</div><p className="mt-2 text-[11px] leading-5 text-[#667085]">{isClient ? "You funded this stream, so you can end it early. The freelancer keeps what has accrued and the rest is refunded." : isFreelancer ? "You can start the clock, then pull out whatever has accrued whenever you like." : "This stream does not involve your wallet, so no actions are available."}</p><div className="mt-5 space-y-3 border-t border-[#eef0f4] pt-4"><SummaryRow label="Token" value={`${USDC.symbol} (${record.token === USDC_ADDRESS ? "verified" : "custom"})`}/><SummaryRow label="Stream ID" value={`#${item.id.toString()}`}/></div><div className="mt-5 space-y-2.5">{isFreelancer && !record.accepted && <button onClick={actions.accept} disabled={!record.active || busy} className="primary flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[12px] font-bold disabled:opacity-50">{busyStep === "acceptStream" ? <Loader2 className="h-4 w-4 animate-spin"/> : <Check className="h-4 w-4"/>} Accept &amp; start the clock</button>}{isFreelancer && record.active && record.accepted && <button onClick={actions.withdraw} disabled={busy || earned === 0n} className="primary flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[12px] font-bold disabled:opacity-50">{busyStep === "withdraw" ? <Loader2 className="h-4 w-4 animate-spin"/> : <WalletCards className="h-4 w-4"/>} Withdraw {fmtAmount(earned)} {USDC.symbol}</button>}{isFreelancer && record.active && !record.accepted && <p className="rounded-xl bg-[#EEF2F7] p-3 text-[10px] leading-4 text-[#667085]">Accept the job first — the counter only runs after acceptance.</p>}{isFreelancer && !record.active && <p className="rounded-xl bg-[#EEF2F7] p-3 text-[10px] leading-4 text-[#667085]">This stream was stopped by the client. Nothing further to do.</p>}{isClient && <button onClick={confirmStop} disabled={!record.active || busy} className="danger flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[12px] font-bold disabled:opacity-50">{busyStep === "stopStream" ? <Loader2 className="h-4 w-4 animate-spin"/> : <Pause className="h-4 w-4"/>} {record.active ? "Stop stream" : "Already stopped"}</button>}</div></div><div className="rounded-2xl border border-[#e7e9f0] bg-[#fafbfc] p-5"><div className="flex items-center gap-2 text-[11px] font-bold text-[#475467]"><CircleHelp className="h-4 w-4 text-[#243B5C]"/> Contract details</div><div className="mt-4 space-y-3"><SummaryRow label="Contract" value={<ContractRef className="text-[11px] text-[#243B5C]" />}/><SummaryRow label="Deployed" value={formatDeployedAt()}/><SummaryRow label="Chain" value={`Monad Testnet (${CHAIN_ID})`}/><SummaryRow label="RPC" value={shortAddress(deployment.rpcUrl)}/></div></div></div></div></main>;
}

export default function Home() {
  const [page, setPage] = useState<Page>("dashboard");
  const [role, setRole] = useState<Role | null>(null);
  const [walletStep, setWalletStep] = useState(false);
  const [account, setAccount] = useState<Address | null>(null);
  const [selectedId, setSelectedId] = useState<bigint | null>(null);

  const provider = useMemo(() => getInjectedProvider(), []);

  const connect = useCallback(async () => {
    if (!provider) {
      toast.error("No browser wallet found", { description: "Install MetaMask or another EIP-1193 wallet to continue." });
      return;
    }
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts?.[0]) { toast.error("No wallet account is available."); return; }
      const chainId = await ensureMonadNetwork(provider);
      if (chainId !== CHAIN_ID) { toast.error("Switch to Monad Testnet before continuing."); return; }
      setAccount(accounts[0] as Address);
      toast.success("Wallet connected", { description: `Monad Testnet · chain ${CHAIN_ID}` });
    } catch (error) {
      if ((error as { code?: number })?.code === 4001) toast.info("Wallet connection was cancelled.");
      else toast.error("Could not connect the wallet.");
    }
  }, [provider]);

  useEffect(() => {
    if (!provider?.on) return;
    const onAccountsChanged = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (!accounts?.[0]) { setAccount(null); setSelectedId(null); setPage("dashboard"); }
      else setAccount(accounts[0] as Address);
    };
    const onChainChanged = (...args: unknown[]) => {
      const id = Number(args[0]);
      if (id !== CHAIN_ID) {
        setAccount(null);
        setSelectedId(null);
        setPage("dashboard");
        toast.error("Wallet changed networks", { description: "Reconnect while on Monad Testnet." });
      }
    };
    provider.on("accountsChanged", onAccountsChanged);
    provider.on("chainChanged", onChainChanged);
    return () => {
      provider.removeListener?.("accountsChanged", onAccountsChanged);
      provider.removeListener?.("chainChanged", onChainChanged);
    };
  }, [provider]);

  const summary = useStreams(account ?? undefined);
  const selected = useMemo(
    () => summary.streams.find((s) => s.id === selectedId) ?? null,
    [summary.streams, selectedId],
  );
  const detail = useStreamDetail(selectedId);
  const actions = useTimeStreamActions(provider, account ?? undefined);

  const effectiveRole: Role = role ?? "client";
  const busyStep = actions.progress.pending ? actions.progress.step : null;

  const handleCreate = async (input: { freelancer: Address; amount: bigint; durationSeconds: bigint }) => {
    const hash = await actions.createStream({
      freelancer: input.freelancer,
      token: USDC_ADDRESS,
      totalAmount: input.amount,
      durationSeconds: input.durationSeconds,
    });
    if (hash) {
      summary.refresh();
      setPage("dashboard");
    }
  };

  const openDetail = (item: StreamSummary) => { setSelectedId(item.id); setPage("detail"); };

  const detailActions = selected
    ? {
        accept: () => { void actions.acceptStream(selected.id).then(() => { detail.refresh(); summary.refresh(); }); },
        withdraw: () => { void actions.withdraw(selected.id).then((h) => { if (h) { detail.refresh(); summary.refresh(); } }); },
        stop: () => { void actions.stopStream(selected.id).then((h) => { if (h) { detail.refresh(); summary.refresh(); setPage("dashboard"); } }); },
      }
    : { accept: () => {}, withdraw: () => {}, stop: () => {} };

  return <div className="min-h-screen bg-[#fbfcfe] text-[#101828]">{account && <AppHeader address={account} role={effectiveRole} page={page} setPage={(next) => { setPage(next); if (next !== "detail") setSelectedId(null); }} onDisconnect={() => { setAccount(null); setSelectedId(null); setPage("dashboard"); }} />}{!account ? <Landing role={role} setRole={(r) => { setRole(r); setWalletStep(true); }} walletStep={walletStep} onBack={() => setWalletStep(false)} onConnect={connect} /> : page === "create" && effectiveRole === "client" ? <CreateStream onBack={() => setPage("dashboard")} onSubmit={(input) => void handleCreate(input)} pendingStep={busyStep} pendingHash={actions.progress.hash} /> : page === "detail" && selected ? <Detail item={selected} viewer={account} earned={detail.earned} loading={detail.loading} error={detail.error} onBack={() => { setPage("streams"); setSelectedId(null); }} onRefresh={() => { detail.refresh(); summary.refresh(); }} actions={detailActions} busyStep={busyStep} /> : <Dashboard streams={summary.streams} total={summary.total} loading={summary.loading} error={summary.error} viewer={account} role={effectiveRole} page={page} onCreate={() => setPage("create")} onOpen={openDetail} onViewAll={() => setPage("streams")} onRetry={summary.refresh} />}{account && <TxPanel step={busyStep} hash={actions.progress.hash} hashes={actions.hashes} />}<footer className="border-t border-[#eaecf2] px-5 py-5 text-center text-[10px] text-[#98a2b3]">FlowPay on Monad Testnet · escrow by <ContractRef className="text-[10px] text-[#98a2b3]" /></footer></div>;
}
