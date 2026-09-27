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
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
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
    streaming: { label: "Streaming", className: "bg-positive-soft text-positive" },
    completed: { label: "Completed", className: "bg-tint text-brand-text" },
    awaiting: {
      label: "Awaiting acceptance",
      className: "bg-warning-soft text-warning",
    },
    stopped: { label: "Stopped", className: "bg-line-soft text-ink-4" },
  };

/** Human label for a stream. The contract stores no title, so none is invented. */
const streamTitle = (id: bigint, record: StreamRecord, viewer: Address) =>
  record.client.toLowerCase() === viewer.toLowerCase()
    ? `Payment to ${shortAddress(record.freelancer)}`
    : `Payment from ${shortAddress(record.client)}`;

function Logo() {
  return <div className="flex items-center gap-2.5"><div className="grid h-9 w-9 place-items-center rounded-xl bg-brand shadow-[0_6px_18px_var(--shadow-ink)]"><div className="relative h-4.5 w-4.5 rounded-full border-[2.5px] border-white"><span className="absolute -bottom-1 -right-1 h-2 w-2 rounded-full bg-white" /></div></div><span className="font-display text-[18px] font-bold tracking-[-.045em] text-ink">FlowPay</span></div>;
}

function WalletPill({ address, onClick }: { address: string; onClick: () => void }) {
  return <button onClick={onClick} className="flex items-center gap-2.5 rounded-xl border border-line-strong bg-raised px-3.5 py-2.5 text-[12px] font-semibold text-ink-2 shadow-[0_2px_6px_var(--shadow-tile)] transition hover:border-line-strong hover:shadow-[0_4px_12px_var(--shadow-tile-hover)] active:scale-[.98]"><span className="h-2 w-2 rounded-full bg-positive-mark" />{shortAddress(address)}<ChevronDown className="h-3.5 w-3.5 text-ink-5" /></button>;
}

function NetworkBadge() {
  return <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-tint px-2.5 py-1.5 text-[10px] font-semibold text-brand-text"><span className="grid h-4 w-4 place-items-center rounded bg-brand text-[8px] font-bold text-white">M</span> Monad Testnet</span>;
}

function AppHeader({ address, page, role, setPage, onDisconnect }: { address: string; page: Page; role: Role; setPage: (page: Page) => void; onDisconnect: () => void }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = (next: Page) => { setPage(next); setMobileOpen(false); };
  return <header className="sticky top-0 z-20 border-b border-line bg-raised/90 px-5 backdrop-blur-xl sm:px-8 lg:px-12"><div className="flex h-[72px] items-center justify-between"><div className="flex items-center gap-4 lg:gap-9"><button aria-label="Toggle navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(!mobileOpen)} className="rounded-lg p-2 text-ink-4 hover:bg-hover lg:hidden"><Menu className="h-5 w-5" /></button><Logo /><nav className="hidden items-center gap-1 lg:flex"><button onClick={() => navigate("dashboard")} className={`header-link ${page === "dashboard" || page === "detail" ? "active" : ""}`}>Dashboard</button><button onClick={() => navigate("streams")} className={`header-link ${page === "streams" ? "active" : ""}`}>My Streams</button>{role === "client" && page !== "detail" && <button onClick={() => navigate("create")} className={`header-link ${page === "create" ? "active" : ""}`}>Create Stream</button>}</nav></div><div className="flex items-center gap-2.5"><NetworkBadge /><ThemeSwitcher /><WalletPill address={address} onClick={onDisconnect} /></div></div>{mobileOpen && <nav className="grid gap-1 border-t border-line py-3 lg:hidden"><button onClick={() => navigate("dashboard")} className="header-link text-left">Dashboard</button><button onClick={() => navigate("streams")} className="header-link text-left">My Streams</button>{role === "client" && page !== "detail" && <button onClick={() => navigate("create")} className="header-link text-left">Create Stream</button>}</nav>}</header>;
}

function Landing({ onConnect, role, setRole, walletStep, onBack }: { onConnect: () => void; role: Role | null; setRole: (role: Role) => void; walletStep: boolean; onBack: () => void }) {
  return <main className="relative grid min-h-screen place-items-center overflow-hidden bg-[radial-gradient(ellipse_at_50%_0%,var(--hero-glow)_0%,var(--surface)_52%)] px-5 py-12"><div className="pointer-events-none absolute -left-36 top-1/3 h-72 w-72 rounded-full bg-blob-a/70 blur-3xl"/><div className="pointer-events-none absolute -right-32 bottom-0 h-80 w-80 rounded-full bg-blob-b/70 blur-3xl"/><ThemeSwitcher className="absolute right-4 top-4 z-10 sm:right-8 sm:top-6" /><div className="relative w-full max-w-[760px] text-center"><div className="mx-auto mb-5 flex w-fit items-center gap-2.5"><div className="grid h-10 w-10 place-items-center rounded-[14px] bg-brand shadow-[0_8px_24px_var(--shadow-ink)]"><div className="relative h-4.5 w-4.5 rounded-full border-[2.5px] border-white"><span className="absolute -bottom-1 -right-1 h-2 w-2 rounded-full bg-white"/></div></div><span className="font-display text-[22px] font-bold tracking-[-.05em] text-ink">FlowPay</span></div><p className="text-[12px] font-semibold tracking-wide text-brand-text">Payments that flow with time.</p>{!walletStep ? <><h1 className="mx-auto mt-4 max-w-[560px] font-display text-[35px] font-bold leading-[1.12] tracking-[-.065em] text-ink sm:text-[46px]">Freelance payments, made fair and effortless.</h1><p className="mx-auto mt-4 max-w-[480px] text-[14px] leading-6 text-ink-4">Stream freelance payments securely and transparently with smart contracts.</p><div className="mt-10 grid gap-4 text-left sm:grid-cols-2">{([{ id: "client" as const, title: "I'm a Client", desc: "Hire freelancers and stream payments automatically as work progresses.", note: "Create and manage payment streams", icon: BriefcaseBusiness }, { id: "freelancer" as const, title: "I'm a Freelancer", desc: "Get paid continuously and withdraw your earned balance whenever you want.", note: "Track and withdraw your earnings", icon: UserRound }]).map((item) => <button key={item.id} onClick={() => setRole(item.id)} className={`group rounded-[20px] border bg-raised/90 p-6 shadow-[0_12px_35px_var(--shadow-card-md)] transition hover:-translate-y-1 hover:border-line-strong hover:shadow-[0_18px_42px_var(--shadow-card-hover)] ${role === item.id ? "border-brand-2 ring-4 ring-brand-text/[.08]" : "border-line"}`}><span className="grid h-11 w-11 place-items-center rounded-[14px] bg-tint text-brand-text"><item.icon className="h-5 w-5"/></span><span className="mt-5 block font-display text-[18px] font-bold tracking-[-.04em] text-ink">{item.title}</span><span className="mt-2 block min-h-[44px] text-[12px] leading-5 text-ink-4">{item.desc}</span><span className="mt-5 flex items-center justify-between border-t border-line-soft pt-4 text-[10px] font-semibold text-ink-5"><span>{item.note}</span><span className="flex items-center gap-1.5 text-[11px] font-bold text-brand-text">Continue <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5"/></span></span></button>)}</div><div className="mt-7 flex items-center justify-center gap-2 text-[10px] font-semibold text-ink-5"><ShieldCheck className="h-4 w-4 text-brand-text"/> Secured by smart contracts <span className="text-ink-6">·</span> Monad Testnet</div>
<div className="mt-3 flex items-center justify-center text-[10px] text-ink-5">Escrow and accrual handled by <ContractRef className="text-[10px] text-ink-5" /></div></> : <div className="mx-auto mt-8 max-w-[460px] text-left"><button onClick={onBack} className="mb-5 flex items-center gap-1.5 text-[11px] font-semibold text-ink-4 hover:text-brand-text"><ArrowLeft className="h-3.5 w-3.5"/> Change role</button><div className="rounded-[22px] border border-line bg-raised p-6 shadow-[0_22px_60px_var(--shadow-panel)] sm:p-8"><span className="eyebrow">{role === "client" ? "Client account" : "Freelancer account"}</span><h1 className="mt-2 font-display text-[29px] font-bold tracking-[-.06em] text-ink">Connect your wallet</h1><p className="mt-2 text-[12px] leading-5 text-ink-4">{role === "client" ? "Connect your wallet to create and manage payment streams." : "Connect your wallet to view your payment streams and earnings."}</p><div className="mt-7 flex items-center gap-3 rounded-xl border border-line bg-sunken p-4"><div className="grid h-11 w-11 place-items-center rounded-xl bg-warning-soft text-[22px] font-bold text-warning-mark">⬡</div><div className="flex-1"><div className="text-[12px] font-bold text-ink-2">Browser wallet</div><div className="mt-1 text-[10px] text-ink-5">MetaMask or any EIP-1193 wallet</div></div><span className="h-2 w-2 rounded-full bg-line-strong"/></div><button onClick={onConnect} className="primary mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[12px] font-bold"><Wallet className="h-4 w-4"/> Connect Wallet <ArrowRight className="h-4 w-4"/></button><div className="mt-5 flex items-center justify-center gap-2 border-t border-line-soft pt-5 text-[10px] font-semibold text-ink-4"><ShieldCheck className="h-4 w-4 text-brand-text"/> Monad Testnet <span className="text-line-strong">·</span> Chain ID {CHAIN_ID}</div></div><p className="mt-4 text-center text-[10px] text-ink-5">Your wallet is your secure sign-in. No email or password needed.</p></div>}</div></main>;
}

function Stat({ label, value, note, icon }: { label: string; value: string; note: string; icon: React.ReactNode }) {
  return <div className="soft-card rounded-2xl border border-line bg-raised p-5"><div className="flex items-start justify-between"><span className="text-[12px] font-medium text-ink-4">{label}</span><span className="grid h-8 w-8 place-items-center rounded-lg bg-tint text-brand-text">{icon}</span></div><div className="mt-5 font-display text-[26px] font-bold tracking-[-.05em] text-ink">{value}</div><div className="mt-1.5 text-[11px] text-ink-5">{note}</div></div>;
}

function SummaryRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return <div className="flex items-center justify-between text-[11px]"><span className="text-ink-5">{label}</span><span className={`${mono ? "font-mono" : "font-semibold"} text-ink-2`}>{value}</span></div>;
}

/**
 * The app is branded FlowPay; the contract it actually talks to is TimeStream.
 * Printing the name next to the address ties the two together, and both are
 * linked so the address can be verified on the explorer without hunting for it.
 */
function ContractRef({ className }: { className?: string }) {
  return <a href={addressUrl(TIMESTREAM_ADDRESS)} target="_blank" rel="noreferrer" title={`${deployment.contractName} · ${TIMESTREAM_ADDRESS}`} className={`inline-flex items-center gap-1.5 underline underline-offset-4 ${className ?? "text-[10px] text-brand-text"}`}>
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
  return <div className="soft-card rounded-2xl border border-line bg-raised p-5 transition hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[0_14px_32px_var(--shadow-card-lg)]"><div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h3 className="font-display text-[15px] font-bold text-ink">{streamTitle(id, record, viewer)}</h3><span className={`rounded-full px-2 py-1 text-[9px] font-bold uppercase tracking-[.1em] ${STATUS_COPY[status].className}`}>{STATUS_COPY[status].label}</span></div><div className="mt-2 text-[11px] text-ink-5">{isClient ? "Freelancer" : "Client"} <span className="font-mono text-ink-4">{shortAddress(isClient ? record.freelancer : record.client)}</span></div></div><span className="font-mono text-[10px] text-ink-5">#{id.toString()}</span></div><div className="mt-6 grid grid-cols-3 gap-3"><div><div className="label">Total</div><div className="value">{total} <small>{USDC.symbol}</small></div></div><div><div className="label">Earned</div><div className="value text-positive">{fmtAmount(lifetimeEarned(record, earned))} <small>{USDC.symbol}</small></div></div><div><div className="label">Remaining</div><div className="value">{fmtAmount(record.totalAmount - lifetimeEarned(record, earned))} <small>{USDC.symbol}</small></div></div></div><div className="mt-5 h-2 overflow-hidden rounded-full bg-line-soft"><div className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} /></div><div className="mt-2 flex justify-between text-[10px] text-ink-5"><span>{percent}% streamed</span><span className="flex items-center gap-1"><Clock3 className="h-3 w-3" /> {!record.accepted ? "clock not started" : status === "completed" ? "fully streamed" : `${formatCountdown(Number(record.endTime) - now)} left`}</span></div><button onClick={() => onOpen(item)} className="mt-5 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-line-strong text-[11px] font-bold text-ink-3 transition hover:border-line-strong hover:bg-tint hover:text-brand-text">View Stream <ArrowRight className="h-3.5 w-3.5" /></button></div>;
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

  if (error) return <main className="mx-auto w-full max-w-[1280px] px-5 py-9 sm:px-8 lg:px-12"><div className="mx-auto grid max-w-[560px] place-items-center rounded-2xl border border-danger-soft bg-raised py-16 text-center"><div className="grid h-14 w-14 place-items-center rounded-2xl bg-danger-soft text-danger"><CircleHelp className="h-6 w-6" /></div><h1 className="mt-5 font-display text-[22px] font-bold tracking-[-.05em] text-ink">Could not read the contract</h1><p className="mt-2 text-[12px] leading-5 text-ink-4">{error}</p><button onClick={onRetry} className="primary mt-6 h-11 rounded-xl px-5 text-[12px] font-bold">Try again</button></div></main>;

  return <main className="mx-auto w-full max-w-[1280px] px-5 py-9 sm:px-8 lg:px-12">{mine.length === 0 && !loading ? <div className="mx-auto grid max-w-[650px] place-items-center py-20 text-center"><div className="grid h-16 w-16 place-items-center rounded-2xl bg-tint text-brand-text"><Link2 className="h-7 w-7" /></div><h1 className="mt-6 font-display text-[28px] font-bold tracking-[-.05em] text-ink">{isFreelancer ? "No active payments" : "No active payment streams"}</h1><p className="mt-3 text-[14px] text-ink-4">{isFreelancer ? "When a client creates a stream for you, your earnings will appear here." : "Create your first payment stream and let payments flow automatically."}</p>{!isFreelancer && <button onClick={onCreate} className="mt-7 flex h-11 items-center gap-2 rounded-xl bg-brand px-5 text-[12px] font-bold text-white transition hover:bg-brand-strong"><Plus className="h-4 w-4" /> Create New Stream</button>}<p className="mt-6 text-[10px] text-ink-5">{total.toString()} stream{total === 1n ? "" : "s"} exist on-chain · none involve this wallet</p></div> : <><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="eyebrow">{page === "streams" ? "On-chain activity" : "Live on Monad Testnet"}</p><h1 className="page-title">{heading}</h1><p className="page-subtitle">{isFreelancer ? "Track your active payment streams and earnings." : "Manage your freelance payments."}</p></div>{!isFreelancer && <button onClick={onCreate} className="primary inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-[12px] font-bold"><Plus className="h-4 w-4" /> Create New Stream</button>}</div>{page !== "streams" && <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{isFreelancer ? <><Stat label="Active Payments" value={active.length.toString()} note="Currently streaming" icon={<Zap className="h-4 w-4" />} /><Stat label="Earned" value={`${fmtAmount(streamed)} ${USDC.symbol}`} note="Across your streams" icon={<ArrowUpRight className="h-4 w-4" />} /><Stat label="Available to Withdraw" value={`${fmtAmount(available)} ${USDC.symbol}`} note="Earned, not withdrawn" icon={<WalletCards className="h-4 w-4" />} /><Stat label="Total Received" value={`${fmtAmount(withdrawn)} ${USDC.symbol}`} note="All time" icon={<Check className="h-4 w-4" />} /></> : <><Stat label="Active Streams" value={active.length.toString()} note="Currently streaming" icon={<Zap className="h-4 w-4" />} /><Stat label="Total Funded" value={`${fmtAmount(funded)} ${USDC.symbol}`} note="Escrowed in the contract" icon={<ArrowUpRight className="h-4 w-4" />} /><Stat label="Streamed" value={`${fmtAmount(streamed)} ${USDC.symbol}`} note="Earned by freelancers" icon={<WalletCards className="h-4 w-4" />} /><Stat label="Remaining" value={`${fmtAmount(funded - streamed)} ${USDC.symbol}`} note="Still locked in streams" icon={<Check className="h-4 w-4" />} /></>}</div>}<div className="mt-10 flex items-center justify-between"><div><h2 className="section-title">{isFreelancer ? "Active Payments" : "Active Streams"}</h2><p className="section-note">Read directly from the contract.</p></div>{page !== "streams" && <button onClick={onViewAll} className="text-[11px] font-bold text-brand-text">View all streams <ArrowRight className="ml-1 inline h-3 w-3" /></button>}</div>{loading && mine.length === 0 ? <div className="mt-4 grid gap-4 lg:grid-cols-2"><div className="soft-card h-[188px] animate-pulse rounded-2xl border border-line bg-raised"/><div className="soft-card h-[188px] animate-pulse rounded-2xl border border-line bg-raised"/></div> : <div className="mt-4 grid gap-4 lg:grid-cols-2">{mine.map((item) => <StreamCard key={item.id.toString()} item={item} viewer={viewer} onOpen={onOpen} now={now}/>)}</div>}</>}</main>;
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

  return <main className="mx-auto w-full max-w-[1100px] px-5 py-9 sm:px-8 lg:px-12"><button onClick={onBack} disabled={busy} className="mb-7 flex items-center gap-2 text-[11px] font-semibold text-ink-4 hover:text-brand-text disabled:opacity-40"><ArrowLeft className="h-3.5 w-3.5"/> Back to Dashboard</button><p className="eyebrow">New agreement · {USDC.symbol} on Monad Testnet</p><h1 className="page-title">Create New Stream</h1><p className="page-subtitle">The full amount is escrowed when the stream is created, then released linearly as time passes.</p><div className="mt-8 grid gap-5 lg:grid-cols-[1fr_370px]"><div className="soft-card rounded-2xl border border-line bg-raised p-6 sm:p-8"><div className="space-y-6"><label className="block"><span className="field-label">Freelancer Wallet Address</span><div className="relative"><input placeholder="0x followed by 40 characters" value={freelancer} onChange={(e) => setFreelancer(e.target.value.trim())} className="field-input w-full pr-10 font-mono"/><button type="button" aria-label="Copy freelancer wallet address" disabled={!freelancer} onClick={() => { navigator.clipboard.writeText(freelancer).then(() => toast.success("Wallet address copied")).catch(() => toast.error("Could not copy wallet address")); }} className="absolute right-3 top-1/2 -translate-y-1/2 disabled:opacity-40"><Copy className="h-4 w-4 text-ink-5"/></button></div></label><div><span className="field-label">Total Amount</span><div className="flex gap-2"><input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="0" step="any" className="field-input flex-1"/><div className="field-input flex w-[190px] items-center gap-2"><span className="h-4 w-4 rounded-full bg-usdc"/><span className="text-[12px] font-semibold">{USDC.symbol}</span></div></div><p className="mt-2 text-[10px] text-ink-5">Token contract: <span className="font-mono">{shortAddress(USDC_ADDRESS)}</span> · {USDC.decimals} decimals</p></div><div><span className="field-label">Duration</span><div className="flex gap-2"><input value={duration} onChange={(e) => setDuration(e.target.value)} type="number" min="0" step="any" className="field-input flex-1"/><select value={unit} onChange={(e) => setUnit(e.target.value)} className="field-input w-[126px]"><option>Hours</option><option>Days</option><option>Weeks</option></select></div>
<p className="mt-2 text-[10px] text-ink-5">The freelancer earns this much for every unit of time the stream runs. Nothing is released before they accept.</p>
</div>
<div className="rounded-xl border border-line bg-sunken p-4">
<div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-[.12em] text-ink-5"><span>Streaming rate</span><span className={rateable ? "text-positive" : "text-ink-5"}>{rateable ? "live preview" : "enter amount + duration"}</span></div>
<div className="mt-3 font-display text-[26px] font-bold tracking-[-.045em] text-brand-text">{rate} <span className="text-[11px] font-medium text-ink-5">{USDC.symbol} / day</span></div>
<div className="mt-3 grid grid-cols-2 gap-3 border-t border-line-soft pt-3 text-[10px] text-ink-5"><div>Per hour <span className="font-semibold text-ink-2">{perHour}</span></div><div>Per week <span className="font-semibold text-ink-2">{perWeek}</span></div></div>
</div><label className="flex items-start gap-3 rounded-xl border border-line bg-sunken p-3.5"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-4 w-4 accent-brand"/><span className="text-[11px] leading-5 text-ink-4">I have reviewed the freelancer address and payment amount.</span></label><button onClick={submit} disabled={!agreed || busy} className="primary h-12 w-full rounded-xl text-[13px] font-bold disabled:cursor-not-allowed disabled:opacity-40">{busy ? <><Loader2 className="mr-2 inline h-4 w-4 animate-spin"/>{pendingStep === "approve" ? "Approving USDC…" : "Creating stream…"}</> : <>Approve &amp; create stream <ArrowRight className="ml-2 inline h-4 w-4"/></>}</button>{pendingHash && <a href={txUrl(pendingHash)} target="_blank" rel="noreferrer" className="block text-center text-[10px] font-bold text-brand-text underline underline-offset-4">View submitted transaction on MonadScan</a>}</div></div><div className="h-fit rounded-2xl border border-line bg-tint p-6 lg:sticky lg:top-24"><div className="flex items-center justify-between"><span className="text-[12px] font-bold text-ink-3">Agreement Summary</span><span className="rounded-full bg-raised px-2 py-1 text-[9px] font-bold uppercase tracking-[.12em] text-brand-text">On-chain</span></div><div className="mt-7 space-y-4"><SummaryRow label="Freelancer" value={freelancer || "Not set"} mono/><SummaryRow label="Total" value={`${amount || "0"} ${USDC.symbol}`}/><SummaryRow label="Duration" value={`${duration || "0"} ${unit.toLowerCase()}`}/><div className="border-t border-line pt-4"><div className="text-[10px] text-ink-5">Streaming rate</div><div className="mt-1 font-display text-[22px] font-bold tracking-[-.04em] text-brand-text">{rate} <span className="text-[11px] font-medium text-ink-5">{USDC.symbol} / day</span></div></div></div><div className="mt-7 flex items-start gap-2 text-[10px] leading-5 text-ink-5"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-text"/> Two transactions: a {USDC.symbol} approval, then the stream creation that escrows the funds.</div><div className="mt-3"><ContractRef className="text-[10px] font-bold text-brand-text" /></div></div></div></main>;
}

function TxPanel({ step, hash, hashes }: { step: string | null; hash: Hash | null; hashes: Partial<Record<string, Hash>> }) {
  if (step === null && hash === null) return null;
  return <div className="rounded-2xl border border-line-strong bg-tint p-5"><div className="flex items-center gap-2 text-[11px] font-bold text-brand-text">{step !== null ? <><Loader2 className="h-3.5 w-3.5 animate-spin"/> {step === "approve" ? "Approving USDC…" : "Sending transaction…"}</> : <><Check className="h-3.5 w-3.5 text-positive-mark"/> Transaction confirmed</>}</div>{Object.entries(hashes).filter(([, v]) => v).map(([k, v]) => <a key={k} href={txUrl(v as Hash)} target="_blank" rel="noreferrer" className="mt-2 flex items-center justify-between text-[10px] text-ink-4"><span className="capitalize">{k}</span><span className="font-mono">{shortAddress(v as string)} <ExternalLink className="inline h-3 w-3" /></span></a>)}</div>;
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

  if (error) return <main className="mx-auto w-full max-w-[1100px] px-5 py-9 sm:px-8 lg:px-12"><button onClick={onBack} className="mb-7 flex items-center gap-2 text-[11px] font-semibold text-ink-4 hover:text-brand-text"><ArrowLeft className="h-3.5 w-3.5"/> Back to Streams</button><div className="rounded-2xl border border-danger-soft bg-raised p-6 text-[12px] text-ink-4">{error}</div></main>;

  return <main className="mx-auto w-full max-w-[1100px] px-5 py-9 sm:px-8 lg:px-12"><button onClick={onBack} className="mb-7 flex items-center gap-2 text-[11px] font-semibold text-ink-4 hover:text-brand-text"><ArrowLeft className="h-3.5 w-3.5"/> Back to Streams</button><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><div className="flex items-center gap-2"><p className="eyebrow">Stream #{item.id.toString()} · Monad Testnet</p><span className={`rounded-full px-2.5 py-1 text-[9px] font-bold uppercase tracking-[.12em] ${STATUS_COPY[status].className}`}>{STATUS_COPY[status].label}</span></div><h1 className="page-title">{streamTitle(item.id, record, viewer)}</h1></div><span className="rounded-lg border border-line-strong bg-raised px-3 py-2 text-[10px] font-bold text-ink-3">{isClient ? "You are the client" : isFreelancer ? "You are the freelancer" : "Observer"}</span></div><div className="mt-8 grid gap-5 lg:grid-cols-[1fr_330px]"><div className="soft-card rounded-2xl border border-line bg-raised p-6 sm:p-8"><div className="flex items-center justify-between"><span className="label uppercase tracking-[.12em]">Earned so far · live</span><span className="flex items-center gap-1.5 text-[10px] font-bold text-positive"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-positive-mark"/> polling {EARNED_POLL_MS / 1000}s</span></div><div className="mt-6 flex items-baseline gap-2"><span className="font-display text-[56px] font-bold tracking-[-.08em] text-ink">{loading ? "—" : fmtAmount(lifetimeEarned(record, earned))}</span><span className="text-[14px] font-semibold text-ink-5">{USDC.symbol}</span></div><div className="mt-2 text-[12px] text-ink-4">{fmtAmount(record.totalAmount)} {USDC.symbol} total · {fmtAmount(earned)} {USDC.symbol} withdrawable now</div><div className="mt-8 h-3 overflow-hidden rounded-full bg-line-soft"><div className="h-full rounded-full bg-brand" style={{ width: `${progressPercent(record, earned)}%` }}/></div><div className="mt-2 flex justify-between text-[10px] text-ink-5"><span>0%</span><span>{progressPercent(record, earned)}%</span><span>100%</span></div><div className="mt-8 grid gap-3 sm:grid-cols-3"><div className="metric"><span>Earned</span><strong>{fmtAmount(lifetimeEarned(record, earned))} {USDC.symbol}</strong></div><div className="metric"><span>Remaining</span><strong>{fmtAmount(record.totalAmount - lifetimeEarned(record, earned))} {USDC.symbol}</strong></div><div className="metric"><span>{record.accepted && status !== "completed" ? "Time remaining" : "Status"}</span><strong>{!record.accepted ? "Not accepted yet" : status === "completed" ? "Fully streamed" : formatCountdown(Number(record.endTime) - now)}</strong></div></div><div className="mt-5 grid gap-3 border-t border-line-soft pt-5 text-[11px] sm:grid-cols-2"><SummaryRow label="Client" value={record.client} mono/><SummaryRow label="Freelancer" value={record.freelancer} mono/><SummaryRow label="Withdrawn" value={`${fmtAmount(record.withdrawn)} ${USDC.symbol}`}/><SummaryRow label="Duration" value={formatDuration(Number(record.durationSeconds))}/><SummaryRow label="Started" value={formatTimestamp(record.startTime)}/><SummaryRow label="Ends" value={formatTimestamp(record.endTime)}/></div><button onClick={onRefresh} className="mt-5 text-[10px] font-bold text-brand-text underline underline-offset-4">Refresh from contract</button></div><div className="space-y-4"><div className="soft-card rounded-2xl border border-line bg-raised p-6"><div className="text-[12px] font-bold text-ink-2">Actions</div><p className="mt-2 text-[11px] leading-5 text-ink-4">{isClient ? "You funded this stream, so you can end it early. The freelancer keeps what has accrued and the rest is refunded." : isFreelancer ? "You can start the clock, then pull out whatever has accrued whenever you like." : "This stream does not involve your wallet, so no actions are available."}</p><div className="mt-5 space-y-3 border-t border-line-soft pt-4"><SummaryRow label="Token" value={`${USDC.symbol} (${record.token === USDC_ADDRESS ? "verified" : "custom"})`}/><SummaryRow label="Stream ID" value={`#${item.id.toString()}`}/></div><div className="mt-5 space-y-2.5">{isFreelancer && !record.accepted && <button onClick={actions.accept} disabled={!record.active || busy} className="primary flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[12px] font-bold disabled:opacity-50">{busyStep === "acceptStream" ? <Loader2 className="h-4 w-4 animate-spin"/> : <Check className="h-4 w-4"/>} Accept &amp; start the clock</button>}{isFreelancer && record.active && record.accepted && <button onClick={actions.withdraw} disabled={busy || earned === 0n} className="primary flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[12px] font-bold disabled:opacity-50">{busyStep === "withdraw" ? <Loader2 className="h-4 w-4 animate-spin"/> : <WalletCards className="h-4 w-4"/>} Withdraw {fmtAmount(earned)} {USDC.symbol}</button>}{isFreelancer && record.active && !record.accepted && <p className="rounded-xl bg-tint p-3 text-[10px] leading-4 text-ink-4">Accept the job first — the counter only runs after acceptance.</p>}{isFreelancer && !record.active && <p className="rounded-xl bg-tint p-3 text-[10px] leading-4 text-ink-4">This stream was stopped by the client. Nothing further to do.</p>}{isClient && <button onClick={confirmStop} disabled={!record.active || busy} className="danger flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[12px] font-bold disabled:opacity-50">{busyStep === "stopStream" ? <Loader2 className="h-4 w-4 animate-spin"/> : <Pause className="h-4 w-4"/>} {record.active ? "Stop stream" : "Already stopped"}</button>}</div></div><div className="rounded-2xl border border-line bg-sunken p-5"><div className="flex items-center gap-2 text-[11px] font-bold text-ink-3"><CircleHelp className="h-4 w-4 text-brand-text"/> Contract details</div><div className="mt-4 space-y-3"><SummaryRow label="Contract" value={<ContractRef className="text-[11px] text-brand-text" />}/><SummaryRow label="Deployed" value={formatDeployedAt()}/><SummaryRow label="Chain" value={`Monad Testnet (${CHAIN_ID})`}/><SummaryRow label="RPC" value={shortAddress(deployment.rpcUrl)}/></div></div></div></div></main>;
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

  return <div className="min-h-screen bg-surface text-ink">{account && <AppHeader address={account} role={effectiveRole} page={page} setPage={(next) => { setPage(next); if (next !== "detail") setSelectedId(null); }} onDisconnect={() => { setAccount(null); setSelectedId(null); setPage("dashboard"); }} />}{!account ? <Landing role={role} setRole={(r) => { setRole(r); setWalletStep(true); }} walletStep={walletStep} onBack={() => setWalletStep(false)} onConnect={connect} /> : page === "create" && effectiveRole === "client" ? <CreateStream onBack={() => setPage("dashboard")} onSubmit={(input) => void handleCreate(input)} pendingStep={busyStep} pendingHash={actions.progress.hash} /> : page === "detail" && selected ? <Detail item={selected} viewer={account} earned={detail.earned} loading={detail.loading} error={detail.error} onBack={() => { setPage("streams"); setSelectedId(null); }} onRefresh={() => { detail.refresh(); summary.refresh(); }} actions={detailActions} busyStep={busyStep} /> : <Dashboard streams={summary.streams} total={summary.total} loading={summary.loading} error={summary.error} viewer={account} role={effectiveRole} page={page} onCreate={() => setPage("create")} onOpen={openDetail} onViewAll={() => setPage("streams")} onRetry={summary.refresh} />}{account && <TxPanel step={busyStep} hash={actions.progress.hash} hashes={actions.hashes} />}<footer className="border-t border-line px-5 py-5 text-center text-[10px] text-ink-5">FlowPay on Monad Testnet · escrow by <ContractRef className="text-[10px] text-ink-5" /></footer></div>;
}
