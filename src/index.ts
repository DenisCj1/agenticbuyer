import { McpServer } from "@modelcontextprotocol/server";
import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createFacilitatorConfig } from "@coinbase/x402";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createLegacyMcpHandler } from "agents/mcp";
import { createMcpHandler } from "agents/mcp/server";
import { withX402, type X402Config } from "agents/x402";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
export { SpendLedger } from "./spend-ledger";

const VERSION = "0.9.0";
const BAZAAR_SEARCH_ENDPOINT =
	"https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";

const BASE_MAINNET = "eip155:8453";
const BASE_SEPOLIA = "eip155:84532";
const CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";
const HARD_MAX_PROVIDER_SPEND_USD = 0.01;
const HARD_DAILY_PROVIDER_SPEND_USD = 0.05;
const DUPLICATE_PURCHASE_WINDOW_MS = 10 * 60 * 1000;
const MAX_PROVIDER_RESULT_CHARS = 12_000;

const USDC_BY_NETWORK: Record<string, string> = {
	[BASE_MAINNET]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
	[BASE_SEPOLIA]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

type SpendLedgerStub = {
	fetch(input: string | Request, init?: RequestInit): Promise<Response>;
};

type SpendLedgerNamespace = {
	idFromName(name: string): unknown;
	get(id: unknown): SpendLedgerStub;
};

type PurchaseEnv = Env & {
	AGENTICBUYER_BUYER_PRIVATE_KEY?: string;
	AGENTICBUYER_LIVE_SPEND_ENABLED?: string;
	CDP_API_KEY_ID?: string;
	CDP_API_KEY_SECRET?: string;
	SPEND_LEDGER?: SpendLedgerNamespace;
};

type BazaarPaymentRequirement = {
	scheme?: string;
	network?: string;
	amount?: string;
	asset?: string;
	payTo?: string;
	maxTimeoutSeconds?: number;
};

type BazaarQuality = {
	l30DaysTotalCalls?: number;
	l30DaysUniquePayers?: number;
	lastCalledAt?: string;
};

export type BazaarResource = {
	resource: string;
	description?: string;
	type?: string;
	x402Version?: number;
	lastUpdated?: string;
	accepts?: BazaarPaymentRequirement[];
	quality?: BazaarQuality;
	serviceName?: string;
	tags?: string[];
	extensions?: unknown;
	iconUrl?: string;
};

type BazaarSearchResponse = {
	x402Version?: number;
	resources?: BazaarResource[];
	partialResults?: boolean;
	searchMethod?: string;
};

export type RankedResource = BazaarResource & {
	agenticBuyerScore: number;
	estimatedUsdPrice: number | null;
	textRelevance: number;
};

export type CandidateDecision = {
	selected: RankedResource | null;
	alternatives: RankedResource[];
	overBudgetAlternatives: Array<
		RankedResource & {
			budgetGapUsd: number;
		}
	>;
};

type BuyerQuote = {
	service: string;
	version: string;
	quoteType: string;
	query: string;
	budgetUsd: number;
	network: string;
	asset: string | null;
	currency: string;
	marketStatus: string;
	discoverySteps: string[];
	selected: RankedResource | null;
	alternatives: RankedResource[];
	overBudgetAlternatives: Array<
		RankedResource & {
			budgetGapUsd: number;
		}
	>;
	candidateCount: number;
	partialResults: boolean;
	searchMethod: string;
	executionReady: boolean;
	nextAction: string;
};

function roundUsd(value: number) {
	return Math.round(value * 1_000_000) / 1_000_000;
}

export function normalizeNetwork(network: string) {
	const value = network.trim().toLowerCase();

	if (value === "base" || value === "base-mainnet" || value === BASE_MAINNET) {
		return BASE_MAINNET;
	}

	if (value === "base-sepolia" || value === BASE_SEPOLIA) {
		return BASE_SEPOLIA;
	}

	return network.trim();
}

export function usdcAssetForNetwork(network: string) {
	return USDC_BY_NETWORK[normalizeNetwork(network)] ?? null;
}

function usdcAmountToUsd(amount?: string): number | null {
	if (!amount || !/^\d+$/.test(amount)) return null;

	try {
		const atomic = BigInt(amount);
		const whole = atomic / 1_000_000n;
		const fraction = atomic % 1_000_000n;
		return Number(whole) + Number(fraction) / 1_000_000;
	} catch {
		return null;
	}
}

function isCompatibleUsdcRequirement(
	requirement: BazaarPaymentRequirement,
	network: string,
) {
	const normalizedNetwork = normalizeNetwork(network);
	const expectedAsset = usdcAssetForNetwork(normalizedNetwork)?.toLowerCase();

	return (
		requirement.scheme?.toLowerCase() === "exact" &&
		requirement.network !== undefined &&
		normalizeNetwork(requirement.network) === normalizedNetwork &&
		requirement.asset?.toLowerCase() === expectedAsset &&
		usdcAmountToUsd(requirement.amount) !== null
	);
}

function lowestUsdcPrice(resource: BazaarResource, network: string): number | null {
	const prices = (resource.accepts ?? [])
		.filter((requirement) => isCompatibleUsdcRequirement(requirement, network))
		.map((requirement) => usdcAmountToUsd(requirement.amount))
		.filter((price): price is number => price !== null && Number.isFinite(price));

	return prices.length > 0 ? Math.min(...prices) : null;
}

function relevanceForQuery(resource: BazaarResource, query: string) {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return 0;

	const tokens = normalizedQuery
		.split(/[^a-z0-9]+/)
		.map((token) => token.trim())
		.filter((token) => token.length >= 2);

	const haystack = [
		resource.serviceName,
		resource.description,
		resource.resource,
		...(resource.tags ?? []),
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();

	let score = haystack.includes(normalizedQuery) ? 30 : 0;

	for (const token of new Set(tokens)) {
		if (haystack.includes(token)) score += 8;
	}

	return Math.min(score, 50);
}

export function rankBazaarResources(
	resources: BazaarResource[],
	budgetUsd: number,
	query: string,
	network: string,
): RankedResource[] {
	return resources
		.map((resource, index) => {
			const price = lowestUsdcPrice(resource, network);
			const calls = Math.max(0, resource.quality?.l30DaysTotalCalls ?? 0);
			const payers = Math.max(0, resource.quality?.l30DaysUniquePayers ?? 0);
			const textRelevance = relevanceForQuery(resource, query);

			const bazaarOrderScore = Math.max(0, 20 - index * 2);
			const priceScore =
				price !== null && budgetUsd > 0
					? Math.max(0, 20 * (1 - Math.min(price / budgetUsd, 1)))
					: 0;
			const payerScore = Math.min(10, Math.log10(payers + 1) * 5);
			const usageScore = Math.min(10, Math.log10(calls + 1) * 3);

			return {
				...resource,
				agenticBuyerScore:
					Math.round(
						(textRelevance +
							bazaarOrderScore +
							priceScore +
							payerScore +
							usageScore) *
							100,
					) / 100,
				estimatedUsdPrice: price,
				textRelevance,
			};
		})
		.sort((a, b) => b.agenticBuyerScore - a.agenticBuyerScore);
}

export function decideCandidates(
	resources: BazaarResource[],
	budgetUsd: number,
	query: string,
	network: string,
): CandidateDecision {
	const ranked = rankBazaarResources(resources, budgetUsd, query, network);

	const withinBudget = ranked.filter(
		(candidate) =>
			candidate.estimatedUsdPrice !== null &&
			candidate.estimatedUsdPrice <= budgetUsd,
	);

	const overBudget = ranked
		.filter(
			(candidate): candidate is RankedResource & { estimatedUsdPrice: number } =>
				candidate.estimatedUsdPrice !== null &&
				candidate.estimatedUsdPrice > budgetUsd,
		)
		.sort((a, b) => {
			const priceDifference = a.estimatedUsdPrice - b.estimatedUsdPrice;
			return priceDifference !== 0
				? priceDifference
				: b.agenticBuyerScore - a.agenticBuyerScore;
		});

	return {
		selected: withinBudget[0] ?? null,
		alternatives: withinBudget.slice(1, 5),
		overBudgetAlternatives: overBudget.slice(0, 5).map((candidate) => ({
			...candidate,
			budgetGapUsd: roundUsd(candidate.estimatedUsdPrice - budgetUsd),
		})),
	};
}

export function buildBazaarSearchUrl({
	query,
	budgetUsd,
	network = "base",
	limit = 10,
	includeQuery = true,
}: {
	query: string;
	budgetUsd?: number;
	network?: string;
	limit?: number;
	includeQuery?: boolean;
}) {
	const normalizedNetwork = normalizeNetwork(network);
	const asset = usdcAssetForNetwork(normalizedNetwork);
	const url = new URL(BAZAAR_SEARCH_ENDPOINT);

	if (includeQuery && query.trim()) {
		url.searchParams.set("query", query.trim());
	}

	url.searchParams.set("network", normalizedNetwork);

	if (asset) {
		url.searchParams.set("asset", asset);
	}

	if (budgetUsd !== undefined) {
		url.searchParams.set("maxUsdPrice", String(budgetUsd));
	}

	url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 20)));
	return url.toString();
}

async function searchBazaar({
	query,
	budgetUsd,
	network,
	limit,
	includeQuery = true,
}: {
	query: string;
	budgetUsd?: number;
	network: string;
	limit: number;
	includeQuery?: boolean;
}): Promise<BazaarSearchResponse> {
	const searchUrl = buildBazaarSearchUrl({
		query,
		budgetUsd,
		network,
		limit,
		includeQuery,
	});

	const response = await fetch(searchUrl, {
		headers: {
			accept: "application/json",
		},
	});

	if (!response.ok) {
		throw new Error(`x402 Bazaar search failed with HTTP ${response.status}.`);
	}

	return (await response.json()) as BazaarSearchResponse;
}

async function createBuyerQuote({
	query,
	budgetUsd,
	network,
	limit,
}: {
	query: string;
	budgetUsd: number;
	network: string;
	limit: number;
}): Promise<BuyerQuote> {
	const normalizedNetwork = normalizeNetwork(network);
	const discoverySteps: string[] = [];

	let result = await searchBazaar({
		query,
		budgetUsd,
		network: normalizedNetwork,
		limit,
	});
	discoverySteps.push("semantic_budget_search");

	let resources = result.resources ?? [];

	if (resources.length === 0) {
		result = await searchBazaar({
			query,
			network: normalizedNetwork,
			limit: Math.max(limit, 10),
		});
		resources = result.resources ?? [];
		discoverySteps.push("semantic_market_search");
	}

	if (resources.length === 0) {
		result = await searchBazaar({
			query,
			network: normalizedNetwork,
			limit: 20,
			includeQuery: false,
		});
		resources = result.resources ?? [];
		discoverySteps.push("network_inventory_fallback");
	}

	const decision = decideCandidates(
		resources,
		budgetUsd,
		query,
		normalizedNetwork,
	);
	const closestOverBudget = decision.overBudgetAlternatives[0] ?? null;

	const marketStatus = decision.selected
		? "MATCH_FOUND"
		: closestOverBudget
			? "OVER_BUDGET_OPTIONS_FOUND"
			: resources.length > 0
				? "MARKET_FOUND_NO_USDC_PRICE"
				: "NO_MATCH";

	return {
		service: "AgenticBuyer",
		version: VERSION,
		quoteType: "x402-provider-route",
		query,
		budgetUsd,
		network: normalizedNetwork,
		asset: usdcAssetForNetwork(normalizedNetwork),
		currency: "USDC",
		marketStatus,
		discoverySteps,
		selected: decision.selected,
		alternatives: decision.alternatives,
		overBudgetAlternatives: decision.overBudgetAlternatives,
		candidateCount: resources.length,
		partialResults: result.partialResults ?? false,
		searchMethod: result.searchMethod ?? "unknown",
		executionReady: Boolean(decision.selected),
		nextAction: decision.selected
			? "A provider is inside budget. AgenticBuyer can prepare this route for downstream purchase execution."
			: closestOverBudget
				? `No provider is inside the $${budgetUsd} budget. The closest observed option is $${closestOverBudget.estimatedUsdPrice}, which is $${closestOverBudget.budgetGapUsd} over budget.`
				: resources.length > 0
					? "Providers were discovered, but AgenticBuyer could not derive a compatible USDC price from the returned payment requirements."
					: "No compatible Base USDC provider was found in the current Bazaar results.",
	};
}

function summarizeResource(resource: RankedResource | null) {
	if (!resource) return null;

	return {
		resource: resource.resource,
		serviceName: resource.serviceName ?? null,
		description: resource.description ?? null,
		tags: resource.tags ?? [],
		agenticBuyerScore: resource.agenticBuyerScore,
		estimatedUsdPrice: resource.estimatedUsdPrice,
		textRelevance: resource.textRelevance,
		quality: resource.quality ?? null,
		accepts: (resource.accepts ?? [])
			.filter((requirement) =>
				isCompatibleUsdcRequirement(requirement, BASE_MAINNET),
			)
			.map((requirement) => ({
				scheme: requirement.scheme,
				network: requirement.network,
				asset: requirement.asset,
				amount: requirement.amount,
				payTo: requirement.payTo,
			})),
	};
}

function publicQuote(quote: BuyerQuote) {
	return {
		...quote,
		selected: summarizeResource(quote.selected),
		alternatives: quote.alternatives.map((candidate) =>
			summarizeResource(candidate),
		),
		overBudgetAlternatives: quote.overBudgetAlternatives.map((candidate) => ({
			...summarizeResource(candidate),
			budgetGapUsd: candidate.budgetGapUsd,
		})),
	};
}

export function isSafeProviderUrl(resourceUrl: string) {
	try {
		const url = new URL(resourceUrl);
		if (url.protocol !== "https:") return false;

		const host = url.hostname.toLowerCase();
		if (
			host === "localhost" ||
			host.endsWith(".localhost") ||
			host.endsWith(".local") ||
			host === "::1" ||
			host.startsWith("fc") ||
			host.startsWith("fd") ||
			host.startsWith("fe80:")
		) {
			return false;
		}

		const parts = host.split(".");
		if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
			const octets = parts.map(Number);
			const [a, b] = octets;

			if (
				octets.some((octet) => octet < 0 || octet > 255) ||
				a === 0 ||
				a === 10 ||
				a === 127 ||
				(a === 100 && b >= 64 && b <= 127) ||
				(a === 169 && b === 254) ||
				(a === 172 && b >= 16 && b <= 31) ||
				(a === 192 && b === 168) ||
				a >= 224
			) {
				return false;
			}
		}

		return true;
	} catch {
		return false;
	}
}

function canonicalUrl(value: string) {
	return new URL(value).toString();
}

export function validateProviderPaymentRequirement({
	selected,
	paymentResourceUrl,
	requirement,
	maxProviderSpendUsd,
}: {
	selected: BazaarResource;
	paymentResourceUrl: string;
	requirement: BazaarPaymentRequirement;
	maxProviderSpendUsd: number;
}) {
	if (!isSafeProviderUrl(selected.resource)) {
		return { ok: false, reason: "Unsafe provider URL.", amountUsd: null };
	}

	try {
		if (canonicalUrl(paymentResourceUrl) !== canonicalUrl(selected.resource)) {
			return {
				ok: false,
				reason: "Provider resource changed after discovery.",
				amountUsd: null,
			};
		}
	} catch {
		return { ok: false, reason: "Invalid provider resource URL.", amountUsd: null };
	}

	if (!isCompatibleUsdcRequirement(requirement, BASE_MAINNET)) {
		return {
			ok: false,
			reason: "Payment requirement is not exact Base mainnet USDC.",
			amountUsd: null,
		};
	}

	const amountUsd = usdcAmountToUsd(requirement.amount);
	if (amountUsd === null) {
		return { ok: false, reason: "Invalid provider payment amount.", amountUsd: null };
	}

	const effectiveMaxUsd = Math.min(
		maxProviderSpendUsd,
		HARD_MAX_PROVIDER_SPEND_USD,
	);

	if (amountUsd > effectiveMaxUsd) {
		return {
			ok: false,
			reason: `Provider requested $${amountUsd}, above the $${effectiveMaxUsd} spend cap.`,
			amountUsd,
		};
	}

	const quotedMatch = (selected.accepts ?? []).some((quoted) => {
		return (
			isCompatibleUsdcRequirement(quoted, BASE_MAINNET) &&
			quoted.amount === requirement.amount &&
			quoted.payTo?.toLowerCase() === requirement.payTo?.toLowerCase()
		);
	});

	if (!quotedMatch) {
		return {
			ok: false,
			reason: "Provider payment details changed after discovery.",
			amountUsd,
		};
	}

	return { ok: true, reason: "OK", amountUsd };
}

function privateKeyLooksValid(value?: string): value is `0x${string}` {
	return Boolean(value && /^0x[a-fA-F0-9]{64}$/.test(value));
}

type SpendLedgerResponse = Record<string, unknown> & {
	allowed?: boolean;
	reason?: string;
};

function preferredQuotedRequirement(resource: BazaarResource) {
	const compatible = (resource.accepts ?? [])
		.filter((requirement) =>
			isCompatibleUsdcRequirement(requirement, BASE_MAINNET),
		)
		.map((requirement) => ({
			requirement,
			amountUsd: usdcAmountToUsd(requirement.amount),
		}))
		.filter(
			(
				item,
			): item is {
				requirement: BazaarPaymentRequirement;
				amountUsd: number;
			} => item.amountUsd !== null,
		)
		.sort((a, b) => a.amountUsd - b.amountUsd);

	return compatible[0] ?? null;
}

async function purchaseFingerprint({
	query,
	resource,
	requirement,
}: {
	query: string;
	resource: string;
	requirement: BazaarPaymentRequirement;
}) {
	const source = [
		query.trim().toLowerCase(),
		canonicalUrl(resource),
		requirement.network ?? "",
		requirement.asset?.toLowerCase() ?? "",
		requirement.amount ?? "",
		requirement.payTo?.toLowerCase() ?? "",
	].join("|");

	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(source),
	);

	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function callSpendLedger(
	env: PurchaseEnv,
	path: "/reserve" | "/finalize" | "/status",
	body?: unknown,
): Promise<SpendLedgerResponse> {
	if (!env.SPEND_LEDGER) {
		throw new Error("Spend ledger binding is not configured.");
	}

	const ledgerId = env.SPEND_LEDGER.idFromName("agenticbuyer-global-spend-ledger");
	const stub = env.SPEND_LEDGER.get(ledgerId);
	const response = await stub.fetch(`https://spend-ledger${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers:
			body === undefined
				? undefined
				: {
						"content-type": "application/json",
					},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	if (!response.ok) {
		throw new Error(`Spend ledger returned HTTP ${response.status}.`);
	}

	return (await response.json()) as SpendLedgerResponse;
}

async function fullSpendStatus(env: PurchaseEnv) {
	const gate = getSpendGateStatus(env);

	if (!env.SPEND_LEDGER) {
		return {
			...gate,
			ledger: null,
		};
	}

	try {
		return {
			...gate,
			ledger: await callSpendLedger(env, "/status"),
		};
	} catch (error) {
		return {
			...gate,
			ledger: null,
			ledgerError:
				error instanceof Error ? error.message : "Spend ledger unavailable.",
		};
	}
}

export function getSpendGateStatus(env: PurchaseEnv) {
	const privateKey = env.AGENTICBUYER_BUYER_PRIVATE_KEY;
	let buyerWalletAddress: string | null = null;

	if (privateKeyLooksValid(privateKey)) {
		try {
			buyerWalletAddress = privateKeyToAccount(privateKey).address;
		} catch {
			buyerWalletAddress = null;
		}
	}

	const receivingWalletMatchesBuyer =
		buyerWalletAddress !== null &&
		buyerWalletAddress.toLowerCase() === env.PAY_TO.toLowerCase();

	const liveSpendEnabled =
		env.AGENTICBUYER_LIVE_SPEND_ENABLED?.trim().toLowerCase() === "true";
	const ledgerConfigured = Boolean(env.SPEND_LEDGER);

	return {
		service: "AgenticBuyer",
		version: VERSION,
		mode: liveSpendEnabled ? "armed" : "locked",
		liveSpendEnabled,
		buyerWalletConfigured: buyerWalletAddress !== null,
		buyerWalletAddress,
		receivingWallet: env.PAY_TO,
		receivingWalletMatchesBuyer,
		providerNetwork: BASE_MAINNET,
		currency: "USDC",
		hardMaxProviderSpendUsd: HARD_MAX_PROVIDER_SPEND_USD,
		dailyProviderSpendCapUsd: HARD_DAILY_PROVIDER_SPEND_USD,
		duplicateWindowMinutes: DUPLICATE_PURCHASE_WINDOW_MS / 60_000,
		ledgerConfigured,
		readyToArm:
			buyerWalletAddress !== null &&
			receivingWalletMatchesBuyer &&
			ledgerConfigured &&
			!liveSpendEnabled,
	};
}

function safeProviderBody(body: unknown) {
	try {
		const serialized =
			typeof body === "string" ? body : JSON.stringify(body);

		if (serialized.length <= MAX_PROVIDER_RESULT_CHARS) {
			return body;
		}

		return {
			truncated: true,
			preview: serialized.slice(0, MAX_PROVIDER_RESULT_CHARS),
			originalChars: serialized.length,
		};
	} catch {
		return {
			truncated: true,
			preview: "[Provider response could not be serialized.]",
		};
	}
}

async function executeProviderPurchase({
	query,
	maxProviderSpendUsd,
	env,
}: {
	query: string;
	maxProviderSpendUsd: number;
	env: PurchaseEnv;
}) {
	const gate = getSpendGateStatus(env);

	if (!gate.buyerWalletConfigured) {
		return {
			service: "AgenticBuyer",
			version: VERSION,
			executed: false,
			error: "BUYER_WALLET_NOT_CONFIGURED",
			gate,
		};
	}

	if (!gate.receivingWalletMatchesBuyer) {
		return {
			service: "AgenticBuyer",
			version: VERSION,
			executed: false,
			error: "BUYER_WALLET_MISMATCH",
			gate,
		};
	}

	if (!gate.ledgerConfigured) {
		return {
			service: "AgenticBuyer",
			version: VERSION,
			executed: false,
			error: "SPEND_LEDGER_NOT_CONFIGURED",
			gate,
		};
	}

	if (!gate.liveSpendEnabled) {
		return {
			service: "AgenticBuyer",
			version: VERSION,
			executed: false,
			error: "LIVE_SPEND_DISABLED",
			message:
				"Provider spending is locked. Set the live-spend gate only after funding and final verification.",
			gate,
		};
	}

	if (
		maxProviderSpendUsd <= 0 ||
		maxProviderSpendUsd > HARD_MAX_PROVIDER_SPEND_USD
	) {
		return {
			service: "AgenticBuyer",
			version: VERSION,
			executed: false,
			error: "SPEND_LIMIT_REJECTED",
			message: `The current hard provider-spend cap is $${HARD_MAX_PROVIDER_SPEND_USD}.`,
			gate,
		};
	}

	const quote = await createBuyerQuote({
		query,
		budgetUsd: maxProviderSpendUsd,
		network: BASE_MAINNET,
		limit: 10,
	});

	if (!quote.selected) {
		return {
			service: "AgenticBuyer",
			version: VERSION,
			executed: false,
			error: "NO_PROVIDER_IN_BUDGET",
			quote: publicQuote(quote),
			gate,
		};
	}

	if (!isSafeProviderUrl(quote.selected.resource)) {
		return {
			service: "AgenticBuyer",
			version: VERSION,
			executed: false,
			error: "UNSAFE_PROVIDER_URL",
			provider: summarizeResource(quote.selected),
			gate,
		};
	}

	const privateKey = env.AGENTICBUYER_BUYER_PRIVATE_KEY;
	if (!privateKeyLooksValid(privateKey)) {
		return {
			service: "AgenticBuyer",
			version: VERSION,
			executed: false,
			error: "BUYER_PRIVATE_KEY_INVALID",
			gate,
		};
	}

	const quoted = preferredQuotedRequirement(quote.selected);
	if (!quoted || quoted.amountUsd > maxProviderSpendUsd) {
		return {
			service: "AgenticBuyer",
			version: VERSION,
			executed: false,
			error: "QUOTED_PAYMENT_NOT_COMPATIBLE",
			provider: summarizeResource(quote.selected),
			gate,
		};
	}

	const fingerprint = await purchaseFingerprint({
		query,
		resource: quote.selected.resource,
		requirement: quoted.requirement,
	});

	const reservation = await callSpendLedger(env, "/reserve", {
		fingerprint,
		amountUsd: quoted.amountUsd,
		provider: quote.selected.resource,
	});

	if (reservation.allowed !== true) {
		return {
			service: "AgenticBuyer",
			version: VERSION,
			executed: false,
			error: reservation.reason ?? "SPEND_RESERVATION_REJECTED",
			message:
				reservation.reason === "DUPLICATE_PURCHASE"
					? "An identical provider purchase was already attempted recently."
					: reservation.reason === "DAILY_SPEND_LIMIT_REACHED"
						? `AgenticBuyer reached its $${HARD_DAILY_PROVIDER_SPEND_USD} daily provider-spend limit.`
						: "AgenticBuyer could not reserve provider spend.",
			provider: summarizeResource(quote.selected),
			ledger: reservation,
			gate,
		};
	}

	const account = privateKeyToAccount(privateKey);
	const client = new x402Client();
	client.register(BASE_MAINNET, new ExactEvmScheme(account));

	let approvedPaymentUsd: number | null = null;

	client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
		const validation = validateProviderPaymentRequirement({
			selected: quote.selected!,
			paymentResourceUrl: paymentRequired.resource.url,
			requirement: selectedRequirements,
			maxProviderSpendUsd,
		});

		if (!validation.ok) {
			return {
				abort: true,
				reason: validation.reason,
			};
		}

		if (
			selectedRequirements.amount !== quoted.requirement.amount ||
			selectedRequirements.payTo?.toLowerCase() !==
				quoted.requirement.payTo?.toLowerCase()
		) {
			return {
				abort: true,
				reason: "Provider payment differs from the reserved Bazaar quote.",
			};
		}

		approvedPaymentUsd = validation.amountUsd;
	});

	const fetchWithPayment = wrapFetchWithPayment(fetch, client);
	const httpClient = new x402HTTPClient(client);

	try {
		const response = await fetchWithPayment(quote.selected.resource, {
			method: "GET",
			headers: {
				accept: "application/json",
			},
		});

		const providerResult = await httpClient.processResponse(response);
		const settled = providerResult.paymentStatus === "settled";

		const ledger = await callSpendLedger(env, "/finalize", {
			fingerprint,
			status: settled ? "settled" : "failed",
			paymentStatus: providerResult.paymentStatus,
		});

		console.log({
			event: "agenticbuyer_provider_purchase",
			fingerprint,
			providerHost: new URL(quote.selected.resource).hostname,
			approvedPaymentUsd,
			paymentStatus: providerResult.paymentStatus,
			httpStatus: response.status,
			settled,
		});

		if (!response.ok) {
			return {
				service: "AgenticBuyer",
				version: VERSION,
				executed: false,
				error: "PROVIDER_REQUEST_FAILED",
				httpStatus: response.status,
				paymentStatus: providerResult.paymentStatus,
				provider: summarizeResource(quote.selected),
				providerPayment: providerResult.header ?? null,
				providerResult: safeProviderBody(providerResult.body),
				ledger,
				gate,
			};
		}

		return {
			service: "AgenticBuyer",
			version: VERSION,
			executed: true,
			query,
			maxProviderSpendUsd,
			providerPaid: settled,
			approvedProviderSpendUsd: approvedPaymentUsd,
			paymentStatus: providerResult.paymentStatus,
			provider: summarizeResource(quote.selected),
			providerPayment: providerResult.header ?? null,
			providerResult: safeProviderBody(providerResult.body),
			ledger,
			gate,
		};
	} catch (error) {
		try {
			await callSpendLedger(env, "/finalize", {
				fingerprint,
				status: "failed",
				paymentStatus: "transport_error",
			});
		} catch {
			// The original provider error is more important than a cleanup error.
		}

		console.log({
			event: "agenticbuyer_provider_purchase",
			fingerprint,
			providerHost: new URL(quote.selected.resource).hostname,
			status: "failed",
			error: error instanceof Error ? error.message : "unknown",
		});

		throw error;
	}
}

function createServer() {
	const server = new McpServer({
		name: "AgenticBuyer",
		version: VERSION,
	});

	server.registerTool(
		"buyer_ping",
		{
			description: "Check that the AgenticBuyer MCP service is online.",
			inputSchema: {
				message: z.string().optional(),
			},
		},
		async ({ message }) => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						service: "AgenticBuyer",
						status: "online",
						message: message ?? "AgenticBuyer MCP is working.",
					}),
				},
			],
		}),
	);

	return server;
}

function createCdpFacilitatorConfig(env: PurchaseEnv) {
	const apiKeyId = env.CDP_API_KEY_ID?.trim();
	const apiKeySecret = env.CDP_API_KEY_SECRET?.trim();

	if (!apiKeyId || !apiKeySecret) {
		throw new Error("Coinbase production x402 credentials are not configured.");
	}

	return createFacilitatorConfig(apiKeyId, apiKeySecret);
}

export function getIncomingPaymentStatus(env: PurchaseEnv) {
	const cdpApiKeyIdConfigured = Boolean(env.CDP_API_KEY_ID?.trim());
	const cdpApiKeySecretConfigured = Boolean(env.CDP_API_KEY_SECRET?.trim());

	return {
		service: "AgenticBuyer",
		version: VERSION,
		network: BASE_MAINNET,
		currency: "USDC",
		facilitator: CDP_FACILITATOR_URL,
		cdpApiKeyIdConfigured,
		cdpApiKeySecretConfigured,
		productionIncomingPaymentsConfigured:
			cdpApiKeyIdConfigured && cdpApiKeySecretConfigured,
		liveProviderSpendEnabled:
			env.AGENTICBUYER_LIVE_SPEND_ENABLED?.trim().toLowerCase() === "true",
	};
}

async function getCdpFacilitatorStatus(env: PurchaseEnv) {
	try {
		const client = new HTTPFacilitatorClient(createCdpFacilitatorConfig(env));
		const supported = await client.getSupported();
		const kinds = supported.kinds.map((kind) => ({
			x402Version: kind.x402Version,
			scheme: kind.scheme,
			network: kind.network,
		}));

		return {
			service: "AgenticBuyer",
			version: VERSION,
			authenticated: true,
			facilitator: CDP_FACILITATOR_URL,
			baseMainnetSupported: kinds.some(
				(kind) => kind.scheme === "exact" && kind.network === BASE_MAINNET,
			),
			supportedKindCount: kinds.length,
			kinds,
		};
	} catch {
		return {
			service: "AgenticBuyer",
			version: VERSION,
			authenticated: false,
			facilitator: CDP_FACILITATOR_URL,
			baseMainnetSupported: false,
			error: "CDP_FACILITATOR_AUTH_FAILED",
		};
	}
}

function createPaidServer(env: PurchaseEnv) {
	const config: X402Config = {
		network: BASE_MAINNET,
		recipient: env.PAY_TO,
		facilitator: createCdpFacilitatorConfig(env),
	};

	const server = withX402(
		new LegacyMcpServer({
			name: "AgenticBuyer Paid",
			version: VERSION,
		}),
		config,
	);

	server.paidTool(
		"buyer_paid_test",
		"Test AgenticBuyer x402 machine payment.",
		0.01,
		{
			request: z.string(),
		},
		{},
		async ({ request }) => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						service: "AgenticBuyer",
						paid: true,
						request,
						message: "x402 payment accepted. AgenticBuyer executed the paid tool.",
					}),
				},
			],
		}),
	);

	server.paidTool(
		"buyer_quote",
		"Discover x402 services, enforce a USDC budget, rank compatible providers, and return AgenticBuyer's preferred route plus alternatives.",
		0.01,
		{
			query: z.string().min(2).max(300),
			budgetUsd: z.number().positive().max(10),
			network: z.string().optional(),
			limit: z.number().int().min(1).max(20).optional(),
		},
		{},
		async ({ query, budgetUsd, network, limit }) => {
			try {
				const quote = await createBuyerQuote({
					query,
					budgetUsd,
					network: network ?? "base",
					limit: limit ?? 10,
				});

				return {
					content: [
						{
							type: "text",
							text: JSON.stringify(publicQuote(quote)),
						},
					],
				};
			} catch (error) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: JSON.stringify({
								service: "AgenticBuyer",
								error: "QUOTE_UNAVAILABLE",
								message:
									error instanceof Error
										? error.message
										: "AgenticBuyer could not create a provider quote.",
							}),
						},
					],
				};
			}
		},
	);

	server.paidTool(
		"buyer_execute",
		"Discover the best Base USDC x402 provider for a request and, only when AgenticBuyer's live-spend gate is explicitly armed, purchase and return the provider result. Provider spend is independently capped.",
		0.01,
		{
			query: z.string().min(2).max(300),
			maxProviderSpendUsd: z
				.number()
				.positive()
				.max(HARD_MAX_PROVIDER_SPEND_USD),
		},
		{},
		async ({ query, maxProviderSpendUsd }) => {
			try {
				const result = await executeProviderPurchase({
					query,
					maxProviderSpendUsd,
					env,
				});

				return {
					isError: result.executed === false,
					content: [
						{
							type: "text",
							text: JSON.stringify(result),
						},
					],
				};
			} catch (error) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: JSON.stringify({
								service: "AgenticBuyer",
								version: VERSION,
								executed: false,
								error: "PROVIDER_EXECUTION_FAILED",
								message:
									error instanceof Error
										? error.message
										: "AgenticBuyer could not execute the provider purchase.",
							}),
						},
					],
				};
			}
		},
	);

	return server;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const purchaseEnv = env as PurchaseEnv;
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "AgenticBuyer",
				version: VERSION,
			});
		}

		if (url.pathname === "/spend-status") {
			return Response.json(await fullSpendStatus(purchaseEnv));
		}

		if (url.pathname === "/payment-status") {
			return Response.json(getIncomingPaymentStatus(purchaseEnv));
		}

		if (url.pathname === "/facilitator-status") {
			const status = await getCdpFacilitatorStatus(purchaseEnv);
			return Response.json(status, {
				status: status.authenticated && status.baseMainnetSupported ? 200 : 503,
			});
		}

		if (url.pathname === "/mcp") {
			return createMcpHandler(createServer)(request, env, ctx);
		}

		if (url.pathname === "/paid-mcp") {
			return createLegacyMcpHandler(createPaidServer(purchaseEnv), {
				route: "/paid-mcp",
			})(request, env, ctx);
		}

		return Response.json({
			name: "AgenticBuyer",
			message: "AgenticBuyer is online.",
			status: "building",
			version: VERSION,
			mcp: "/mcp",
			paidMcp: "/paid-mcp",
			spendStatus: "/spend-status",
			paymentStatus: "/payment-status",
			facilitatorStatus: "/facilitator-status",
			network: BASE_MAINNET,
			tools: {
				free: ["buyer_ping"],
				paid: ["buyer_paid_test", "buyer_quote", "buyer_execute"],
			},
			capabilities: {
				discovery: true,
				budgetEnforcement: true,
				qualityRanking: true,
				networkNormalization: true,
				usdcAssetResolution: true,
				inventoryFallback: true,
				downstreamExecution: true,
				liveSpendGate: true,
				hardProviderSpendCapUsd: HARD_MAX_PROVIDER_SPEND_USD,
				dailyProviderSpendCapUsd: HARD_DAILY_PROVIDER_SPEND_USD,
				duplicatePurchaseProtection: true,
				persistentSpendLedger: true,
				structuredPurchaseLogging: true,
				productionIncomingPaymentsConfigured:
					getIncomingPaymentStatus(purchaseEnv)
						.productionIncomingPaymentsConfigured,
				cdpFacilitator: true,
			},
		});
	},
} satisfies ExportedHandler<Env>;