import { McpServer } from "@modelcontextprotocol/server";
import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLegacyMcpHandler } from "agents/mcp";
import { createMcpHandler } from "agents/mcp/server";
import { withX402, type X402Config } from "agents/x402";
import { z } from "zod";

const VERSION = "0.6.0";
const BAZAAR_SEARCH_ENDPOINT =
	"https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";

const USDC_BY_NETWORK: Record<string, string> = {
	"eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
	"eip155:84532": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
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

function roundUsd(value: number) {
	return Math.round(value * 1_000_000) / 1_000_000;
}

export function normalizeNetwork(network: string) {
	const value = network.trim().toLowerCase();

	if (value === "base" || value === "base-mainnet" || value === "eip155:8453") {
		return "eip155:8453";
	}

	if (value === "base-sepolia" || value === "eip155:84532") {
		return "eip155:84532";
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

function lowestUsdcPrice(resource: BazaarResource, network: string): number | null {
	const normalizedNetwork = normalizeNetwork(network);
	const expectedAsset = usdcAssetForNetwork(normalizedNetwork)?.toLowerCase();

	const prices = (resource.accepts ?? [])
		.filter((requirement) => {
			const requirementNetwork = requirement.network
				? normalizeNetwork(requirement.network)
				: null;
			const asset = requirement.asset?.toLowerCase();

			return (
				(!requirementNetwork || requirementNetwork === normalizedNetwork) &&
				(!expectedAsset || !asset || asset === expectedAsset)
			);
		})
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

	// Coinbase Bazaar's current REST API expects an asset address,
	// not the human-readable "usdc" alias.
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
}) {
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

function createPaidServer(env: Env) {
	const config: X402Config = {
		network: env.X402_NETWORK as X402Config["network"],
		recipient: env.PAY_TO,
		facilitator: {
			url: "https://x402.org/facilitator",
		},
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
							text: JSON.stringify(quote),
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

	return server;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				service: "AgenticBuyer",
				version: VERSION,
			});
		}

		if (url.pathname === "/mcp") {
			return createMcpHandler(createServer)(request, env, ctx);
		}

		if (url.pathname === "/paid-mcp") {
			return createLegacyMcpHandler(createPaidServer(env), {
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
			network: env.X402_NETWORK,
			tools: {
				free: ["buyer_ping"],
				paid: ["buyer_paid_test", "buyer_quote"],
			},
			capabilities: {
				discovery: true,
				budgetEnforcement: true,
				qualityRanking: true,
				networkNormalization: true,
				usdcAssetResolution: true,
				inventoryFallback: true,
				downstreamExecution: false,
			},
		});
	},
} satisfies ExportedHandler<Env>;