import { McpServer } from "@modelcontextprotocol/server";
import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createLegacyMcpHandler } from "agents/mcp";
import { createMcpHandler } from "agents/mcp/server";
import { withX402, type X402Config } from "agents/x402";
import { z } from "zod";

const VERSION = "0.5.0";
const BAZAAR_SEARCH_ENDPOINT =
	"https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";

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

function lowestUsdcPrice(resource: BazaarResource): number | null {
	const prices = (resource.accepts ?? [])
		.map((requirement) => usdcAmountToUsd(requirement.amount))
		.filter((price): price is number => price !== null && Number.isFinite(price));

	return prices.length > 0 ? Math.min(...prices) : null;
}

export function rankBazaarResources(
	resources: BazaarResource[],
	budgetUsd: number,
): RankedResource[] {
	return resources
		.map((resource, index) => {
			const price = lowestUsdcPrice(resource);
			const calls = Math.max(0, resource.quality?.l30DaysTotalCalls ?? 0);
			const payers = Math.max(0, resource.quality?.l30DaysUniquePayers ?? 0);

			const relevanceScore = Math.max(0, 40 - index * 5);
			const priceScore =
				price !== null && budgetUsd > 0
					? Math.max(0, 25 * (1 - Math.min(price / budgetUsd, 1)))
					: 0;
			const payerScore = Math.min(20, Math.log10(payers + 1) * 10);
			const usageScore = Math.min(15, Math.log10(calls + 1) * 5);

			return {
				...resource,
				agenticBuyerScore:
					Math.round(
						(relevanceScore + priceScore + payerScore + usageScore) * 100,
					) / 100,
				estimatedUsdPrice: price,
			};
		})
		.sort((a, b) => b.agenticBuyerScore - a.agenticBuyerScore);
}

export function decideCandidates(
	resources: BazaarResource[],
	budgetUsd: number,
): CandidateDecision {
	const ranked = rankBazaarResources(resources, budgetUsd);

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
	limit = 5,
}: {
	query: string;
	budgetUsd?: number;
	network?: string;
	limit?: number;
}) {
	const url = new URL(BAZAAR_SEARCH_ENDPOINT);
	url.searchParams.set("query", query.trim());
	url.searchParams.set("network", network);
	url.searchParams.set("asset", "usdc");

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
}: {
	query: string;
	budgetUsd?: number;
	network: string;
	limit: number;
}): Promise<BazaarSearchResponse> {
	const searchUrl = buildBazaarSearchUrl({
		query,
		budgetUsd,
		network,
		limit,
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
	const inBudgetSearch = await searchBazaar({
		query,
		budgetUsd,
		network,
		limit,
	});

	let marketSearchUsed = false;
	let resources = inBudgetSearch.resources ?? [];
	let partialResults = inBudgetSearch.partialResults ?? false;
	let searchMethod = inBudgetSearch.searchMethod ?? "unknown";

	// A useful buyer should not simply stop when a strict budget search is empty.
	// Scan the same market without the price ceiling so the caller can see the
	// nearest alternatives and exactly how far they are above budget.
	if (resources.length === 0) {
		const marketSearch = await searchBazaar({
			query,
			network,
			limit: Math.max(limit, 10),
		});

		marketSearchUsed = true;
		resources = marketSearch.resources ?? [];
		partialResults = marketSearch.partialResults ?? false;
		searchMethod = marketSearch.searchMethod ?? searchMethod;
	}

	const decision = decideCandidates(resources, budgetUsd);
	const closestOverBudget = decision.overBudgetAlternatives[0] ?? null;

	const marketStatus = decision.selected
		? "MATCH_FOUND"
		: closestOverBudget
			? "OVER_BUDGET_OPTIONS_FOUND"
			: "NO_MATCH";

	return {
		service: "AgenticBuyer",
		version: VERSION,
		quoteType: "x402-provider-route",
		query,
		budgetUsd,
		network,
		currency: "USDC",
		marketStatus,
		marketSearchUsed,
		selected: decision.selected,
		alternatives: decision.alternatives,
		overBudgetAlternatives: decision.overBudgetAlternatives,
		candidateCount: resources.length,
		partialResults,
		searchMethod,
		executionReady: Boolean(decision.selected),
		nextAction: decision.selected
			? "A provider is inside budget. AgenticBuyer can prepare this route for downstream purchase execution."
			: closestOverBudget
				? `No provider is inside the $${budgetUsd} budget. The closest observed option is $${closestOverBudget.estimatedUsdPrice}, which is $${closestOverBudget.budgetGapUsd} over budget.`
				: "No relevant provider was found in the current Bazaar results. Broaden the request or try another network.",
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
		"Search the x402 Bazaar, enforce a provider budget, score candidates, and return AgenticBuyer's preferred provider route plus nearest over-budget alternatives when necessary.",
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
					limit: limit ?? 5,
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
				overBudgetFallback: true,
				downstreamExecution: false,
			},
		});
	},
} satisfies ExportedHandler<Env>;